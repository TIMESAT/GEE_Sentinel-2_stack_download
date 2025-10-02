/**
 * Sentinel-2 (HARMONIZED) VI → time-stacked GeoTIFF, per VI
 * Author: Zhanzhang Cai
 * Email: zhanzhang.cai@nateko.lu.se
 * Date: 2025-10-02
 *
 * Description:
 * This script processes Sentinel-2 imagery within a specified date range and geographical point.
 * It applies cloud masking and calculates various indices including NDVI, EVI, kNDVI, NIRv, NDWI, and NMDI.
 *
 * Usage:
 * - Define the point of interest and buffer zone.
 * - Set the date range for filtering the Sentinel-2 collection.
 * - The script adds calculated indices as bands to each image in the collection.
 *
 * Outputs:
 * The script prints the image collection details and exports selected VI of each image in the collection.
 */


/* ============ User parameters ============ */
var point = ee.Geometry.Point([17.48075, 60.08733]).buffer(1000); // AOI
var startDate   = '2022-01-01';
var endDate     = '2024-12-31';
var outputFolder = 'S2_timeseries';   // Google Drive folder
var exportScale  = 10;       // meters
var maxPixels    = 1e13;
// Select any VIs you want to export (case-sensitive):
// var viList = ['NDVI', 'EVI', 'kNDVI', 'NIRv', 'NDWI', 'NMDI'];
var viList = ['NDVI'];

/* ============ Helpers ============ */
// SCL mask: keep vegetation(4), bare ground(5), water(6)
function maskS2_SCL(img) {
  var scl = img.select('SCL');
  var good = scl.eq(4).or(scl.eq(5));
  return img.updateMask(good);
}

// Scale reflectances needed by some indices (S2 SR scale factor = 1e-4)
function scl(img, band) { return img.select(band).multiply(0.0001); }

// Compute one VI as a single-band image named by VI; preserve key properties
function computeVI(img, viName) {
  var B2  = scl(img, 'B2');   // Blue
  var B3  = scl(img, 'B3');   // Green
  var B4  = scl(img, 'B4');   // Red
  var B8  = scl(img, 'B8');   // NIR
  var B11 = scl(img, 'B11');  // SWIR1
  var B12 = scl(img, 'B12');  // SWIR2

  var out;
  if (viName === 'NDVI') {
    out = img.normalizedDifference(['B8','B4']).rename('NDVI'); // scale-invariant
  } else if (viName === 'EVI') {
    out = B8.subtract(B4)
            .divide(B8.add(B4.multiply(6)).subtract(B2.multiply(7.5)).add(1.0))
            .multiply(2.5)
            .rename('EVI');
  } else if (viName === 'kNDVI') {
    var ndvi = img.normalizedDifference(['B8','B4']);
    var sigma = B8.add(B4).multiply(0.5);
    out = ndvi.expression('exp(-((ndvi*ndvi)/(2*sigma*sigma)))',
                          {'ndvi': ndvi, 'sigma': sigma})
              .rename('kNDVI');
  } else if (viName === 'NIRv') {
    var ndvi2 = img.normalizedDifference(['B8','B4']);
    out = ndvi2.multiply(B8).rename('NIRv');
  } else if (viName === 'NDWI') {
    out = img.normalizedDifference(['B3','B8']).rename('NDWI'); // McFeeters
  } else if (viName === 'NMDI') {
    // Wang & Qu (2007): (NIR - (SWIR1 - SWIR2)) / (NIR + (SWIR1 - SWIR2))
    out = B8.subtract(B11.subtract(B12))
            .divide(B8.add(B11.subtract(B12)))
            .rename('NMDI');
  } else {
    out = img.normalizedDifference(['B8','B4']).rename('NDVI');
  }

  // IMPORTANT: keep system:index (for toBands naming) and time for debugging/order
  return out.copyProperties(img, ['system:index', 'system:time_start']);
}

// Build a time-sorted single-band collection for a VI (band name == VI)
function buildVICollection(viName, aoi, fromDate, toDate) {
  var col = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
              .filterBounds(aoi)
              .filterDate(fromDate, toDate)
              .filter(ee.Filter.lte('CLOUDY_PIXEL_PERCENTAGE', 75))
              .map(maskS2_SCL)
              .map(function (img) { return computeVI(img, viName); })
              .sort('system:time_start');
  return col;
}

/* ============ Run ============ */
Map.addLayer(point, {color: 'yellow'}, 'AOI');

viList.forEach(function(viName) {
  var viCol = buildVICollection(viName, point, startDate, endDate);

  print(viName + ' collection', viCol);
  print(viName + ' count', viCol.size());
  print(viName + ' first image bandNames (expect single VI name):',
        ee.Image(viCol.first()).bandNames());

  // Collapse to a multiband image in time order.
  // Band names will be: "<VI>_<system:index>", e.g., "NDVI_20180702T104019_..._T31UES"
  var stack = viCol.toBands().clip(point);

  // Borrow projection from a sample S2 image to keep native grid
  var projImg = ee.Image(
      ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterBounds(point).first()
    ).select('B4');
  stack = stack.reproject({crs: projImg.projection()});

  print(viName + ' stack bandNames (with system:index suffix):', stack.bandNames());

  var baseName = 'S2H_' + viName + '_stack_' + startDate + '_' + endDate;

  Export.image.toDrive({
    image: stack,
    description: baseName,
    folder: outputFolder,
    fileNamePrefix: baseName,
    region: point,
    scale: exportScale,
    maxPixels: maxPixels
  });
});
