import _ from 'lodash';
import path from 'path';
import url from 'url';
import logger from './logger';
import _fs from 'fs';
import B from 'bluebird';
import { tempDir, fs, util, zip, timing } from 'appium-support';
import request from 'request';
import asyncRequest from 'request-promise';
import LRU from 'lru-cache';
import AsyncLock from 'async-lock';
import sanitize from 'sanitize-filename';


const ZIP_EXTS = ['.zip', '.ipa'];
const ZIP_MIME_TYPES = [
  'application/zip',
  'application/x-zip-compressed',
  'multipart/x-zip',
];
const CACHED_APPS_MAX_AGE = 1000 * 60 * 60 * 24; // ms
const APPLICATIONS_CACHE = new LRU({
  maxAge: CACHED_APPS_MAX_AGE, // expire after 24 hours
  updateAgeOnGet: true,
  dispose: async (app, {fullPath}) => {
    if (!await fs.exists(fullPath)) {
      return;
    }

    logger.info(`The application '${app}' cached at '${fullPath}' has expired`);
    await fs.rimraf(fullPath);
  },
  noDisposeOnSet: true,
});
const APPLICATIONS_CACHE_GUARD = new AsyncLock();
const SANITIZE_REPLACEMENT = '-';
const DEFAULT_BASENAME = 'appium-app';

process.on('exit', () => {
  if (!APPLICATIONS_CACHE.length) {
    return;
  }

  const appPaths = APPLICATIONS_CACHE.values()
    .map(({fullPath}) => fullPath);
  logger.debug(`Performing cleanup of ${appPaths.length} cached ` +
    `${util.pluralize('application', appPaths.length)}`);
  for (const appPath of appPaths) {
    try {
      // Asynchronous calls are not supported in onExit handler
      fs.rimrafSync(appPath);
    } catch (e) {
      logger.warn(e.message);
    }
  }
});


async function retrieveHeaders (link) {
  try {
    const response = await asyncRequest({
      url: link,
      method: 'HEAD',
      resolveWithFullResponse: true,
      timeout: 5000,
    });
    return response.headers;
  } catch (e) {
    logger.debug(`Cannot send HEAD request to '${link}'. Original error: ${e.message}`);
  }
  return {};
}

function getCachedApplicationPath (link, currentModified) {
  if (!APPLICATIONS_CACHE.has(link) || !currentModified) {
    return null;
  }

  const {lastModified, fullPath} = APPLICATIONS_CACHE.get(link);
  if (lastModified && currentModified.getTime() <= lastModified.getTime()) {
    return fullPath;
  }
  logger.debug(`'Last-Modified' timestamp of '${link}' has been updated. ` +
    `A fresh copy of the application is going to be downloaded.`);
  return null;
}

function verifyAppExtension (app, supportedAppExtensions) {
  if (supportedAppExtensions.includes(path.extname(app))) {
    return app;
  }
  throw new Error(`New app path '${app}' did not have ` +
    `${util.pluralize('extension', supportedAppExtensions.length, false)}: ` +
    supportedAppExtensions);
}

async function configureApp (app, supportedAppExtensions) {
  if (!_.isString(app)) {
    // immediately shortcircuit if not given an app
    return;
  }
  if (!_.isArray(supportedAppExtensions)) {
    supportedAppExtensions = [supportedAppExtensions];
  }

  let newApp = app;
  let shouldUnzipApp = false;
  let archiveHash = null;
  let currentModified = null;
  const {protocol, pathname} = url.parse(newApp);
  const isUrl = ['http:', 'https:'].includes(protocol);

  return await APPLICATIONS_CACHE_GUARD.acquire(app, async () => {
    if (isUrl) {
      // Use the app from remote URL
      logger.info(`Using downloadable app '${newApp}'`);
      const headers = await retrieveHeaders(newApp);
      if (headers['last-modified']) {
        logger.debug(`App Last-Modified: ${headers['last-modified']}`);
        currentModified = new Date(headers['last-modified']);
      }
      const cachedPath = getCachedApplicationPath(app, currentModified);
      if (cachedPath) {
        if (await fs.exists(cachedPath)) {
          logger.info(`Reusing previously downloaded application at '${cachedPath}'`);
          return verifyAppExtension(cachedPath, supportedAppExtensions);
        }
        logger.info(`The application at '${cachedPath}' does not exist anymore. Deleting it from the cache`);
        APPLICATIONS_CACHE.del(app);
      }

      let fileName = null;
      const basename = sanitize(path.basename(decodeURIComponent(pathname)), {
        replacement: SANITIZE_REPLACEMENT
      });
      const extname = path.extname(basename);
      // to determine if we need to unzip the app, we have a number of places
      // to look: content type, content disposition, or the file extension
      if (ZIP_EXTS.includes(extname)) {
        fileName = basename;
        shouldUnzipApp = true;
      }
      if (headers['content-type']) {
        const ct = headers['content-type'];
        logger.debug(`Content-Type: ${ct}`);
        // the filetype may not be obvious for certain urls, so check the mime type too
        if (ZIP_MIME_TYPES.some((mimeType) => new RegExp(`\\b${_.escapeRegExp(mimeType)}\\b`).test(ct))) {
          if (!fileName) {
            fileName = `${DEFAULT_BASENAME}.zip`;
          }
          shouldUnzipApp = true;
        }
      }
      if (headers['content-disposition'] && /^attachment/i.test(headers['content-disposition'])) {
        logger.debug(`Content-Disposition: ${headers['content-disposition']}`);
        const match = /filename="([^"]+)/i.exec(headers['content-disposition']);
        if (match) {
          fileName = sanitize(match[1], {
            replacement: SANITIZE_REPLACEMENT
          });
          shouldUnzipApp = shouldUnzipApp || ZIP_EXTS.includes(path.extname(fileName));
        }
      }
      if (!fileName) {
        // assign the default file name and the extension if none has been detected
        const resultingName = basename
          ? basename.substring(0, basename.length - extname.length)
          : DEFAULT_BASENAME;
        let resultingExt = extname;
        if (!supportedAppExtensions.includes(resultingExt)) {
          logger.info(`The current file extension '${resultingExt}' is not supported. ` +
            `Defaulting to '${_.first(supportedAppExtensions)}'`);
          resultingExt = _.first(supportedAppExtensions);
        }
        fileName = `${resultingName}${resultingExt}`;
      }
      const targetPath = await tempDir.path({
        prefix: fileName,
        suffix: '',
      });
      newApp = await downloadApp(newApp, targetPath);
    } else if (await fs.exists(newApp)) {
      // Use the local app
      logger.info(`Using local app '${newApp}'`);
      shouldUnzipApp = ZIP_EXTS.includes(path.extname(newApp));
    } else {
      let errorMessage = `The application at '${newApp}' does not exist or is not accessible`;
      // protocol value for 'C:\\temp' is 'c:', so we check the length as well
      if (_.isString(protocol) && protocol.length > 2) {
        errorMessage = `The protocol '${protocol}' used in '${newApp}' is not supported. ` +
          `Only http: and https: protocols are supported`;
      }
      throw new Error(errorMessage);
    }

    if (shouldUnzipApp) {
      const archivePath = newApp;
      archiveHash = await fs.hash(archivePath);
      if (APPLICATIONS_CACHE.has(app) && archiveHash === APPLICATIONS_CACHE.get(app).hash) {
        const {fullPath} = APPLICATIONS_CACHE.get(app);
        if (await fs.exists(fullPath)) {
          if (archivePath !== app) {
            await fs.rimraf(archivePath);
          }
          logger.info(`Will reuse previously cached application at '${fullPath}'`);
          return verifyAppExtension(fullPath, supportedAppExtensions);
        }
        logger.info(`The application at '${fullPath}' does not exist anymore. Deleting it from the cache`);
        APPLICATIONS_CACHE.del(app);
      }
      const tmpRoot = await tempDir.openDir();
      try {
        newApp = await unzipApp(archivePath, tmpRoot, supportedAppExtensions);
      } finally {
        if (newApp !== archivePath && archivePath !== app) {
          await fs.rimraf(archivePath);
        }
      }
      logger.info(`Unzipped local app to '${newApp}'`);
    } else if (!path.isAbsolute(newApp)) {
      newApp = path.resolve(process.cwd(), newApp);
      logger.warn(`The current application path '${app}' is not absolute ` +
        `and has been rewritten to '${newApp}'. Consider using absolute paths rather than relative`);
      app = newApp;
    }

    verifyAppExtension(newApp, supportedAppExtensions);

    if (app !== newApp && (archiveHash || currentModified)) {
      if (APPLICATIONS_CACHE.has(app)) {
        const {fullPath} = APPLICATIONS_CACHE.get(app);
        // Clean up the obsolete entry first if needed
        if (fullPath !== newApp && await fs.exists(fullPath)) {
          await fs.rimraf(fullPath);
        }
      }
      APPLICATIONS_CACHE.set(app, {
        hash: archiveHash,
        lastModified: currentModified,
        fullPath: newApp,
      });
    }
    return newApp;
  });
}

async function downloadApp (app, targetPath) {
  const {href} = url.parse(app);
  const timer = new timing.Timer().start();
  try {
    // don't use request-promise here, we need streams
    await new B((resolve, reject) => {
      request(href)
        .on('error', reject) // handle real errors, like connection errors
        .on('response', (res) => {
          // handle responses that fail, like 404s
          if (res.statusCode >= 400) {
            return reject(new Error(`${res.statusCode} - ${res.statusMessage}`));
          }
        })
        .pipe(_fs.createWriteStream(targetPath))
        .on('close', resolve);
    });
  } catch (err) {
    throw new Error(`Problem downloading app from url ${href}: ${err.message}`);
  }
  const secondsElapsed = timer.getDuration().asSeconds;
  const {size} = await fs.stat(targetPath);
  logger.debug(`'${href}' (${util.toReadableSizeString(size)}) ` +
    `has been downloaded to '${targetPath}' in ${secondsElapsed.toFixed(3)}s`);
  if (secondsElapsed >= 2) {
    const bytesPerSec = Math.floor(size / secondsElapsed);
    logger.debug(`Approximate download speed: ${util.toReadableSizeString(bytesPerSec)}/s`);
  }
  return targetPath;
}

/**
 * Extracts the bundle from an archive into the given folder
 *
 * @param {string} zipPath Full path to the archive containing the bundle
 * @param {string} dstRoot Full path to the folder where the extracted bundle
 * should be placed
 * @param {Array<string>|string} supportedAppExtensions The list of extensions
 * the target application bundle supports, for example ['.apk', '.apks'] for
 * Android packages
 * @returns {string} Full path to the bundle in the destination folder
 * @throws {Error} If the given archive is invalid or no application bundles
 * have been found inside
 */
async function unzipApp (zipPath, dstRoot, supportedAppExtensions) {
  await zip.assertValidZip(zipPath);

  if (!_.isArray(supportedAppExtensions)) {
    supportedAppExtensions = [supportedAppExtensions];
  }

  const tmpRoot = await tempDir.openDir();
  try {
    logger.debug(`Unzipping '${zipPath}'`);
    await zip.extractAllTo(zipPath, tmpRoot);
    const allExtractedItems = await fs.glob('**', {cwd: tmpRoot});
    logger.debug(`Extracted ${util.pluralize('item', allExtractedItems.length, true)} from '${zipPath}'`);
    const allBundleItems = allExtractedItems
      .filter((relativePath) => supportedAppExtensions.includes(path.extname(relativePath)))
      // Get the top level match
      .sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
    if (_.isEmpty(allBundleItems)) {
      throw new Error(`App zip unzipped OK, but we could not find '${supportedAppExtensions}' ` +
        util.pluralize('bundle', supportedAppExtensions.length, false) +
        ` in it. Make sure your archive contains at least one package having ` +
        `'${supportedAppExtensions}' ${util.pluralize('extension', supportedAppExtensions.length, false)}`);
    }
    const matchedBundle = _.first(allBundleItems);
    logger.debug(`Matched ${util.pluralize('item', allBundleItems.length, true)} in the extracted archive. ` +
      `Assuming '${matchedBundle}' is the correct bundle`);
    const dstPath = path.resolve(dstRoot, matchedBundle);
    await fs.mv(path.resolve(tmpRoot, matchedBundle), dstPath, {mkdirp: true});
    return dstPath;
  } finally {
    await fs.rimraf(tmpRoot);
  }
}

function isPackageOrBundle (app) {
  return (/^([a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+)+$/).test(app);
}

function getCoordDefault (val) {
  // going the long way and checking for undefined and null since
  // we can't be assured `elId` is a string and not an int. Same
  // thing with destElement below.
  return util.hasValue(val) ? val : 0.5;
}

function getSwipeTouchDuration (waitGesture) {
  // the touch action api uses ms, we want seconds
  // 0.8 is the default time for the operation
  let duration = 0.8;
  if (typeof waitGesture.options.ms !== 'undefined' && waitGesture.options.ms) {
    duration = waitGesture.options.ms / 1000;
    if (duration === 0) {
      // set to a very low number, since they wanted it fast
      // but below 0.1 becomes 0 steps, which causes errors
      duration = 0.1;
    }
  }
  return duration;
}

/**
 * Finds all instances 'firstKey' and create a duplicate with the key 'secondKey',
 * Do the same thing in reverse. If we find 'secondKey', create a duplicate with the key 'firstKey'.
 *
 * This will cause keys to be overwritten if the object contains 'firstKey' and 'secondKey'.

 * @param {*} input Any type of input
 * @param {String} firstKey The first key to duplicate
 * @param {String} secondKey The second key to duplicate
 */
function duplicateKeys (input, firstKey, secondKey) {
  // If array provided, recursively call on all elements
  if (_.isArray(input)) {
    return input.map((item) => duplicateKeys(item, firstKey, secondKey));
  }

  // If object, create duplicates for keys and then recursively call on values
  if (_.isPlainObject(input)) {
    const resultObj = {};
    for (let [key, value] of _.toPairs(input)) {
      const recursivelyCalledValue = duplicateKeys(value, firstKey, secondKey);
      if (key === firstKey) {
        resultObj[secondKey] = recursivelyCalledValue;
      } else if (key === secondKey) {
        resultObj[firstKey] = recursivelyCalledValue;
      }
      resultObj[key] = recursivelyCalledValue;
    }
    return resultObj;
  }

  // Base case. Return primitives without doing anything.
  return input;
}

/**
 * Takes a desired capability and tries to JSON.parse it as an array,
 * and either returns the parsed array or a singleton array.
 *
 * @param {string|Array<String>} cap A desired capability
 */
function parseCapsArray (cap) {
  if (_.isArray(cap)) {
    return cap;
  }

  let parsedCaps;
  try {
    parsedCaps = JSON.parse(cap);
    if (_.isArray(parsedCaps)) {
      return parsedCaps;
    }
  } catch (ign) {
    logger.warn(`Failed to parse capability as JSON array`);
  }
  if (_.isString(cap)) {
    return [cap];
  }
  throw new Error(`must provide a string or JSON Array; received ${cap}`);
}

export {
  configureApp, isPackageOrBundle, getCoordDefault, getSwipeTouchDuration, duplicateKeys, parseCapsArray
};
