/**
 * Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

var testGenerator = testSteps();

function testSteps()
{
  const name = this.window ? window.location.pathname : "Splendid Test";
  const description = "My Test Database";

  // Open a datbase for the first time.
  let request = mozIndexedDB.open(name, 1, description);

  // Sanity checks
  ok(request instanceof IDBRequest, "Request should be an IDBRequest");
  ok(request instanceof IDBOpenDBRequest, "Request should be an IDBOpenDBRequest");
  //ok(request instanceof EventTarget, "Request should be an EventTarget");
  is(request.source, null, "Request should have no source");
  try {
    request.result;
    ok(false, "Getter should have thrown!");
  } catch (e if e.result == 0x80660006 /* NS_ERROR_DOM_INDEXEDDB_NOTALLOWED_ERR */) {
    ok(true, "Getter threw the right exception");
  }

  request.onerror = errorHandler;
  request.onsuccess = grabEventAndContinueHandler;
  let event = yield;

  let versionChangeEventCount = 0;
  let db1, db2, db3;

  db1 = event.target.result;
  db1.addEventListener("versionchange", function(event) {
    ok(true, "Got version change event");
    ok(event instanceof IDBVersionChangeEvent, "Event is of the right type");
    is(event.target.source, null, "Correct source");
    is(event.target, db1, "Correct target");
    is(event.target.version, 1, "Correct db version");
    is(event.oldVersion, 1, "Correct event oldVersion");
    is(event.newVersion, 2, "Correct event newVersion");
    is(versionChangeEventCount++, 0, "Correct count");
    db1.close();
  }, false);

  // Open the database again and trigger an upgrade that should succeed
  request = mozIndexedDB.open(name, 2, description);
  request.onerror = errorHandler;
  request.onsuccess = errorHandler;
  request.onupgradeneeded = grabEventAndContinueHandler;
  request.onblocked = errorHandler;
  event = yield;

  // Test the upgradeneeded event.
  ok(event instanceof IDBVersionChangeEvent, "Event is of the right type");
  ok(event.target.result instanceof IDBDatabase, "Good result");
  db2 = event.target.result;
  is(event.target.transaction.mode, "versionchange",
     "Correct mode");
  is(db2.version, 2, "Correct db version");
  is(event.oldVersion, 1, "Correct event oldVersion");
  is(event.newVersion, 2, "Correct event newVersion");

  request.onupgradeneeded = errorHandler;
  request.onsuccess = grabEventAndContinueHandler;
  event = yield;

  db2.addEventListener("versionchange", function(event) {
    ok(true, "Got version change event");
    ok(event instanceof IDBVersionChangeEvent, "Event is of the right type");
    is(event.target.source, null, "Correct source");
    is(event.target, db2, "Correct target");
    is(event.target.version, 2, "Correct db version");
    is(event.oldVersion, 2, "Correct event oldVersion");
    is(event.newVersion, 3, "Correct event newVersion");
    is(versionChangeEventCount++, 1, "Correct count");
  }, false);

  // Test opening the existing version again
  request = mozIndexedDB.open(name, 2, description);
  request.onerror = errorHandler;
  request.onsuccess = grabEventAndContinueHandler;
  request.onblocked = errorHandler;
  event = yield;

  db3 = event.target.result;

  // Test an upgrade that should fail
  request = mozIndexedDB.open(name, 3, description);
  request.onerror = errorHandler;
  request.onsuccess = errorHandler;
  request.onupgradeneeded = errorHandler;
  request.onblocked = grabEventAndContinueHandler;

  event = yield;
  ok(true, "Got version change blocked event");
  ok(event instanceof IDBVersionChangeEvent, "Event is of the right type");
  is(event.target.source, null, "Correct source");
  is(event.target.transaction, null, "Correct transaction");
  is(event.target, request, "Correct target");
  is(db3.version, 2, "Correct db version");
  is(event.oldVersion, 2, "Correct event oldVersion");
  is(event.newVersion, 3, "Correct event newVersion");
  versionChangeEventCount++;
  db2.close();
  db3.close();

  request.onupgradeneeded = grabEventAndContinueHandler;
  request.onsuccess = grabEventAndContinueHandler;

  event = yield;
  event = yield;

  db3 = event.target.result;
  db3.close();

  // Test another upgrade that should succeed.
  request = mozIndexedDB.open(name, 4);
  request.onerror = errorHandler;
  request.onsuccess = errorHandler;
  request.onupgradeneeded = grabEventAndContinueHandler;
  request.onblocked = errorHandler;

  event = yield;

  ok(event instanceof IDBVersionChangeEvent, "Event is of the right type");
  ok(event.target.result instanceof IDBDatabase, "Good result");
  is(event.target.transaction.mode, "versionchange",
     "Correct mode");
  is(event.oldVersion, 3, "Correct event oldVersion");
  is(event.newVersion, 4, "Correct event newVersion");

  request.onsuccess = grabEventAndContinueHandler;

  event = yield;
  ok(event.target.result instanceof IDBDatabase, "Expect a database here");
  is(event.target.result.version, 4, "Right version");
  is(db3.version, 3, "After closing the version should not change!");
  is(db2.version, 2, "After closing the version should not change!");
  is(db1.version, 1, "After closing the version should not change!");

  is(versionChangeEventCount, 3, "Saw all expected events");

  finishTest();
  yield;
}
