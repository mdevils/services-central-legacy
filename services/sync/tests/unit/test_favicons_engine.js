/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/*
 * This file really tests both the favicons engine and the favicons store. The
 * fact that they are intermingled in this file is an indication that the API
 * should be changed!
 */

Svc.DefaultPrefs.set("registerEngines", "Bookmarks,Favicons");
Cu.import("resource://services-sync/record.js");
Cu.import("resource://services-sync/constants.js");
Cu.import("resource://services-sync/engines.js");
Cu.import("resource://services-sync/service.js");
Cu.import("resource://services-sync/util.js");
Cu.import("resource://services-sync/engines/favicons.js");

const TEST_URI          = "http://test.com/";
const TEST_FAVICON_URI  = "http://test.com/sync/favicon.ico";
const EXPIRATION_OFFSET = 500000;

// Sample file.
const ICON_16_ICO  = "favicon-big16.ico";
const ICON_16_MIME = "image/x-icon";
const ICON_16_FILE = do_get_file(ICON_16_ICO);
const ICON_16_DATA = readFileData(ICON_16_FILE);
const ICON_16_LEN  = 1406;
const ICON_16_DATAURL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABEUlEQVQ4jbWSsXEDMQwEL0CIWAWwBdTCFtgCU0Xs4bMPVAgL+GZUwTrg/5uS7JECGwlnOLzF4UDpr6u1RkqJkIgIWmv03nkrvN/vRAQhsUks+1mkAZN+B63rDTOj7MIicZUgxlkkUkq4+88AMzsB7J23GLCrxKYg50xKiUXiRdxaw8xYdgD67nyAmOBlHgfA3cfsMR7NggN2ZHLcLftYp4Pn7jMgJNydnPOjkwgEnGtbJsH1CXhsotZKiTjDlpnRe8fdT9E2Cee7I5daKwpRShkOzAx3f5l9k7hcLoREzplaK4uCCLGuNx620Ht/sb5Ntt/+xFor8Zx87El/Ur13Yg9n7p5z/gwwg47w3H0E9Z/1BfAkJDRE3FKkAAAAAElFTkSuQmCC";

/*
 * readFileData()
 *
 * Reads the data from the specified nsIFile, and returns an array of bytes.
 *
 * Borrowed and augmented from Places tests.
 */
function readFileData(aFile) {
  let inputStream = Cc["@mozilla.org/network/file-input-stream;1"]
                    .createInstance(Ci.nsIFileInputStream);
  // Init the stream as RD_ONLY, -1 == default permissions.
  inputStream.init(aFile, 0x01, -1, null);
  let size = inputStream.available();

  // Use a binary input stream to grab the bytes.
  let bis = Cc["@mozilla.org/binaryinputstream;1"].
            createInstance(Ci.nsIBinaryInputStream);
  bis.setInputStream(inputStream);

  let bytes = bis.readByteArray(size);
  if (size != bytes.length) {
    throw "Didn't read expected number of bytes";
  }
  return bytes;
}

/*
 * setAndGetFaviconData()
 *
 * Calls setFaviconData() with the specified image data,
 * and then retrieves it with getFaviconData(). Returns
 * and array of bytes, the MIME type, and the data URL.
 *
 * Extended from places/tests/unit/test_favicons.js.
 */
function setAndGetFaviconData(aFilename, aData, aMimeType) {
  let iconsvc = Svc.Favicons;
  let iconURI = Utils.makeURI("http://sync.places.test/" + aFilename);
  try {
    iconsvc.setFaviconData(iconURI,
                           aData, aData.length, aMimeType,
                           Number.MAX_VALUE);
  } catch (ex) {}
  let dataURL = iconsvc.getFaviconDataAsDataURL(iconURI);
  try {
    iconsvc.setFaviconDataFromDataURL(iconURI, dataURL, Number.MAX_VALUE);
  } catch (ex) {}
  let mimeTypeOutparam = {};

  let outData = iconsvc.getFaviconData(iconURI, mimeTypeOutparam);

  return [outData, mimeTypeOutparam.value, dataURL];
}


/**
 * Compares two arrays, and returns true if they are equal.
 * Stolen and slightly extended from places/tests/head_common.js.
 *
 * @param aArray1
 *        First array to compare.
 * @param aArray2
 *        Second array to compare.
 */
function compareArrays(aArray1, aArray2) {
  if (!aArray1 && !aArray2) {
    _("compareArrays: both arrays are falsy.");
    return true;
  }
  if (!aArray1 || !aArray2) {
    _("compareArrays: one array is falsy.");
    return false;
  }

  if (aArray1.length != aArray2.length) {
    _("compareArrays: array lengths differ\n");
    return false;
  }

  for (let i = 0; i < aArray1.length; i++) {
    if (aArray1[i] != aArray2[i]) {
      _("compareArrays: arrays differ at index " + i + ": " +
        "(" + aArray1[i] + ") != (" + aArray2[i] +")\n");
      return false;
    }
  }

  return true;
}


function checkArrays(a, b) {
  do_check_true(compareArrays(a, b));
}

function makeIncomingRecord(guid, expiration) {
  let incoming = new FaviconRecord("favicons", guid);

  incoming.url  = TEST_FAVICON_URI;
  incoming.icon = ICON_16_DATAURL;
  incoming.expiration = expiration;

  return incoming;
}

/**
 * Clean up after ourselves.
 */
function dropIcon(url, cb) {
  let drop = "DELETE FROM moz_favicons WHERE url = :iconURL";
  let db = PlacesUtils.history.QueryInterface(Ci.nsPIPlacesDatabase)
                     .DBConnection;
  let statement = db.createAsyncStatement(drop);
  statement.params.iconURL = url;
  statement.executeAsync({
    handleCompletion: function (reason) {
      statement.finalize();
      cb();
    }
  });
}

function run_test() {
  initTestLogging("Trace");
  for each (let item in ["Engine.Favicons", "Store.Favicons", "Record.Favicons"]) {
    Log4Moz.repository.getLogger("Sync." + item).level = Log4Moz.Level.Trace;
  }
  run_next_test();
}

add_test(function test_favicon_store() {
  _("Test that a favicon can be stored through FaviconsStore.");
  let s = new FaviconsEngine()._store;

  let pageURI = NetUtil.newURI(TEST_URI);

  // Add a page with a bookmark.
  PlacesUtils.bookmarks.insertBookmark(
    PlacesUtils.toolbarFolderId, pageURI,
    PlacesUtils.bookmarks.DEFAULT_INDEX, "Test bookmark"
  );

  let guid = TEST_FAVICON_URI;
  do_check_eq(ICON_16_DATA.length, ICON_16_LEN);

  let expiration = Date.now() + EXPIRATION_OFFSET;

  _("Icon does not exist yet.");
  do_check_false(s.itemExists(guid));
  do_check_false(guid in s.getAllIDs());

  s.storeFavicon(TEST_FAVICON_URI, ICON_16_DATAURL, expiration,
    function (err) {
      do_check_true(!err);

      _("Set a favicon for the page.");
      PlacesUtils.favicons.setFaviconUrlForPage(
        pageURI, NetUtil.newURI(TEST_FAVICON_URI)
      );

      _("Make sure it stuck.");
      do_check_eq(PlacesUtils.favicons.getFaviconForPage(pageURI).spec,
                  TEST_FAVICON_URI);
      do_check_true(s.itemExists(guid));
      _("All IDs: " + JSON.stringify(s.getAllIDs()));
      do_check_true(guid in s.getAllIDs());

      _("Verify retrieval of expiration.");
      s.faviconExpiry(TEST_FAVICON_URI, function (err, result) {
        _("faviconExpiry callback: " + err + ", " + result);
        do_check_true(!err);
        do_check_true(s.itemExists(guid));
        do_check_eq(result, expiration);

        _("Verify fetching other metadata.");
        let r = s._retrieveRecordByGUID(guid, function (err, result) {
          do_check_true(!err);
          do_check_eq(result.guid,       guid);
          do_check_eq(result.expiration, expiration);
          do_check_eq(result.url,        TEST_FAVICON_URI);
          run_next_test();
        });
      });
    });
});

add_test(function test_favicon_engine_reconciliation() {
  _("Test that reconciliation occurs through expiration times.");
  let e = new FaviconsEngine();

  let guid     = TEST_FAVICON_URI;       // TODO: real GUID
  let incoming = makeIncomingRecord(guid, 1234);

  // Prior test adds the favicon, and the timestamp is newer than ours.
  do_check_false(e._reconcile(incoming));

  // But if we fast-forward the timestamp...
  incoming.expiration = Date.now() + 2 * EXPIRATION_OFFSET;
  do_check_true(e._reconcile(incoming));

  // Drop the icon, and we need to apply the incoming record regardless of
  // expiration.
  incoming.expiration = 1;
  dropIcon(TEST_FAVICON_URI, function () {
    do_check_true(e._reconcile(incoming));
    run_next_test();
  });
});

add_test(function test_favicon_store_create_remove() {
  _("Test that FaviconsStore.create will store data, and remove will remove it.");
  let s = new FaviconsEngine()._store;

  let guid = TEST_FAVICON_URI;       // TODO: real GUID
  let expiration = Date.now() + EXPIRATION_OFFSET;
  let incoming = makeIncomingRecord(guid, expiration);
  do_check_false(s.itemExists(guid));
  s.create(incoming);
  do_check_true(s.itemExists(guid));     // TODO: more details. Data!
  s.remove(incoming);
  do_check_false(s.itemExists(guid));
  run_next_test();
});

add_test(function test_favicon_sync() {
  _("Test that calling .sync() on a FaviconsEngine will do the right thing " +
    "for synthetic server-side records.");
  let e = Engines.get("favicons");
  let s = e._store;
  e.enabled = true;

  let faviconGUID = TEST_FAVICON_URI;       // TODO: real GUID
  do_check_false(s.itemExists(faviconGUID));

  Service.serverURL  = "http://localhost:8080/";
  Service.clusterURL = "http://localhost:8080/";
  Service.username   = "johndoe";
  Service.password   = "ilovejane";
  Service.passphrase = "bbbbbabcdeabcdeabcdeabcdea";

  let engines = {favicons: {version: e.version,
                            syncID: e.syncID}};

  let global    = new ServerWBO('global', {syncID: Service.syncID,
                                           storageVersion: STORAGE_VERSION,
                                           engines: engines});
  let keys      = new ServerWBO("keys");
  let favicons  = new ServerCollection({}, true);

  let collectionsHelper = track_collections_helper();
  let upd               = collectionsHelper.with_updated_collection;
  let collections       = collectionsHelper.collections;

  let server = httpd_setup({
    "/1.1/johndoe/info/collections":    collectionsHelper.handler,
    "/1.1/johndoe/storage/meta/global": upd("meta",     global.handler()),
    "/1.1/johndoe/storage/crypto/keys": upd("crypto",   keys.handler()),
    "/1.1/johndoe/storage/favicons":    upd("favicons", favicons.handler())
  });

  try {
    _("Initial setup.");
    Service.login();
    do_check_true(e.enabled);
    e.sync();

    new FakeCryptoService();
    _("Put a record on the server.");
    let payload = {id:         faviconGUID,
                   url:        TEST_FAVICON_URI,
                   expiration: Date.now() + EXPIRATION_OFFSET,
                   icon:       ICON_16_DATAURL};

    let faviconWBO = new ServerWBO(faviconGUID, encryptPayload(payload));
    favicons.wbos[faviconGUID] = faviconWBO;
    let ts1 = new_timestamp();
    collectionsHelper.update_collection("favicons", ts1);
    faviconWBO.modified = ts1;

    _("Syncing favicons...");
    do_check_true(e.enabled);
    e.sync();
    do_check_neq(faviconWBO.payload, undefined);
    do_check_true(s.itemExists(faviconGUID));

    _("Testing via getFaviconData.");
    // We cannot test that the stored data is the same as the input data:
    // Places reserves the right to convert inputs into, e.g., a 16x16 PNG.
    // Instead we store, retrieve, re-store and return the data to get an
    // expected result. We rely on Places' existing test coverage to know that
    // this is the right thing to do!
    let faviconURI = Utils.makeURI(TEST_FAVICON_URI);
    let [expectData, expectMimeType, expectDataURL] =
      setAndGetFaviconData(ICON_16_ICO,
                           ICON_16_DATA,
                           ICON_16_MIME);
    let stored = Svc.Favicons.getFaviconData(faviconURI, {}, {});

    _("Invoking createRecord.");
    let record = s.createRecord(faviconGUID, "favicons");
    _("Icon is " + record.icon);
    do_check_eq(record.icon, expectDataURL);
    do_check_neq(record.icon.indexOf(expectMimeType), -1);

    _("Delete the item.");
    let deleted = new FaviconRecord("favicons", faviconGUID);
    deleted.deleted = true;
    s.applyIncoming(deleted);
    do_check_false(s.itemExists(faviconGUID));

    _("Now attempt to retrieve the icon.");
    record = s.createRecord(faviconGUID, "favicons");
    do_check_true(record.deleted);
    do_check_eq(undefined, record.icon);

  } finally {
    Svc.Prefs.resetBranch("");
    Records.clearCache();
    server.stop(run_next_test);
  }
});

add_test(function test_favicon_upload_download() {
  _("Test that FaviconsEngine will upload and download.");
  let e = Engines.get("favicons");
  let s = e._store;
  let t = e._tracker;
  e.enabled = true;

  function cleanup() {
    e._resetClient();
    s.wipe();
    t.clearChangedIDs();
    t.resetScore();
    PlacesUtils.favicons.expireAllFavicons();
  }

  cleanup();
  Svc.Obs.notify("weave:engine:start-tracking");   // We skip usual startup...

  let faviconGUID = TEST_FAVICON_URI;       // TODO: real GUID
  do_check_false(s.itemExists(faviconGUID));

  Service.serverURL  = "http://localhost:8080/";
  Service.clusterURL = "http://localhost:8080/";
  Service.username   = "johndoe";
  Service.password   = "ilovejane";
  Service.passphrase = "bbbbbabcdeabcdeabcdeabcdea";

  let engines = {favicons: {version: e.version,
                            syncID: e.syncID}};

  let global    = new ServerWBO('global', {syncID: Service.syncID,
                                           storageVersion: STORAGE_VERSION,
                                           engines: engines});
  let keys      = new ServerWBO("keys");
  let bookmarks = new ServerCollection({}, true);
  let clients   = new ServerCollection({}, true);
  let favicons  = new ServerCollection({}, true);

  let collectionsHelper = track_collections_helper();
  let upd               = collectionsHelper.with_updated_collection;
  let collections       = collectionsHelper.collections;

  let server = httpd_setup({
    "/1.1/johndoe/info/collections":    collectionsHelper.handler,
    "/1.1/johndoe/storage/meta/global": upd("meta",     global.handler()),
    "/1.1/johndoe/storage/crypto/keys": upd("crypto",   keys.handler()),
    "/1.1/johndoe/storage/bookmarks":   upd("bookmarks", bookmarks.handler()),
    "/1.1/johndoe/storage/clients":     upd("clients", clients.handler()),
    "/1.1/johndoe/storage/favicons":    upd("favicons", favicons.handler())
  });

    _("Initial setup.");
    Service.login();
    do_check_true(e.enabled);
    e.sync();

    new FakeCryptoService();

    _("Add record locally.");
    _("Adding a folder...");
    let fxuri = Utils.makeURI("http://getfirefox.com/");
    let folderID = PlacesUtils.bookmarks.createFolder(
      PlacesUtils.bookmarks.toolbarFolder, "Folder 1", 0);

    _("Adding a bookmark...");
    let bookmarkID = PlacesUtils.bookmarks.insertBookmark(
      folderID, fxuri, PlacesUtils.bookmarks.DEFAULT_INDEX, "Get Firefox!");

    _("Prepare to add favicon.");
    let faviconURI = Utils.makeURI(TEST_FAVICON_URI);
    let expiration = Date.now() + EXPIRATION_OFFSET;

    _("Add an observer so we see the onItemChanged, and can proceed with the test.");
    let svc = Cc["@mozilla.org/browser/nav-bookmarks-service;1"]
                .getService(Components.interfaces.nsINavBookmarksService);
    let obs = {
      onBeginUpdateBatch: function () {},
      onEndUpdateBatch:   function () {},
      onItemAdded:        function () {},

      onItemChanged: function (id, prop, isAnno, val, lastModified, itemType,
                               parentId, guid, parentGUID) {
        if (prop != "favicon") {
          return;
        }
        do_check_eq(id, bookmarkID);
        do_check_eq(val, TEST_FAVICON_URI);

        try {
          _("Syncing favicons...");
          e.sync();

          _("Check that the favicon made it to the server.");
          _("WBOs: " + JSON.stringify(favicons.wbos));
          do_check_true(faviconGUID in favicons.wbos);
          let payload = JSON.parse(favicons.wbos[faviconGUID].payload);
          let ciphertext = JSON.parse(payload.ciphertext);
          do_check_eq(ciphertext.icon, ICON_16_DATAURL);

          _("Check that we can download, apply, and get the same stored values.");

          _("Cleaning up prior to syncing...");
          cleanup();

          _("Ensure the local record is gone.");
          let err;
          try {
            Svc.Favicons.getFaviconDataAsDataURL(faviconURI);
          } catch (ex) {
            err = ex;
          }
          do_check_eq(err.result, Components.results.NS_ERROR_NOT_AVAILABLE);

          _("Syncing...");
          e.sync();

          _("Checking that the record now exists in both places...");
          do_check_true(faviconGUID in favicons.wbos);
          do_check_true(s.itemExists(faviconGUID));
          let stored = Svc.Favicons.getFaviconDataAsDataURL(faviconURI);
          do_check_eq(stored, ICON_16_DATAURL);

          Utils.nextTick(run_next_test);

        } catch (ex) {
          _("Exception in test: " + Utils.exceptionStr(ex));
          do_throw(ex);
        } finally {
          svc.removeObserver(obs);
          Svc.Prefs.resetBranch("");
          Records.clearCache();
          server.stop(run_next_test);
        }
      }
    };
    svc.addObserver(obs, false);

    Svc.Favicons.setFaviconDataFromDataURL(faviconURI, ICON_16_DATAURL, expiration);
    PlacesUtils.favicons.setFaviconUrlForPage(fxuri, faviconURI);
});

// TODO: test expiration on one machine propagating as a spurious delete to others.
// We should treat expiration as a non-event; allow the other clients to expire their own.
// This should be academic, of course.
