// Launcher script for WebWorkers.
//
// Sets up context and runs a worker script. This is not intended to be
// invoked directly. Rather, it is invoked automatically when constructing a
// new Worker() object.
//
//      usage: node worker.js <sock> <script>
//
//      The <sock> parameter is the filesystem path to a UNIX domain socket
//      that is listening for connections. The <script> parameter is the
//      path to the JavaScript source to be executed as the body of the
//      worker.

var assert = require('assert');
var fs = require('fs');
var net = require('net');
var path = require('path');
var vm = require('vm');
var util = require('util');
var wwutil = require('./webworker-util');

var WebSocket = require('ws');

// Catch exceptions
//
// This implements the Runtime Script Errors section fo the Web Workers API
// specification at
//
//  http://www.whatwg.org/specs/web-workers/current-work/#runtime-script-errors
//
// XXX: There are all sorts of pieces of the error handling spec that are not
//      being done correctly. Pick a clause, any clause.
var inErrorHandler = false;
var exceptionHandler = function(e) {
    if (!inErrorHandler && workerCtx.onerror) {
        inErrorHandler = true;
        workerCtx.onerror(e);
        inErrorHandler = false;

        return;
    }

    // Don't bother setting inErrorHandler here, as we're already delivering
    // the event to the master anyway
    ms.send([wwutil.MSGTYPE_ERROR, {
        'message' : wwutil.getErrorMessage(e),
        'filename' : wwutil.getErrorFilename(e),
        'lineno' : wwutil.getErrorLine(e)
    }]);
};

// Message handling function for messages from the master
var handleMessage = function(msg, fd) {
    if (!wwutil.isValidMessage(msg)) {
        wwutil.debug('Received invalid message: ' + util.inspect(msg));
        return;
    }

    switch(msg[0]) {
    case wwutil.MSGTYPE_NOOP:
        break;

    case wwutil.MSGTYPE_CLOSE:
        // Conform to the Web Workers API for termination
        workerCtx.closing = true;

        // Close down the event sources that we know about
        ws.close();

        // Request that the worker perform any application-level shutdown
        if (workerCtx.onclose) {
            workerCtx.onclose();
        }

        break;

    case wwutil.MSGTYPE_USER:
        // XXX: I have no idea what the event object here should really look
        //      like. I do know that it needs a 'data' elements, though.
    	if (workerCtx.onmessage || workerCtx.eventHandlers['message'].length > 0) {
	        var e = { data : msg[1] };
	
	        if (fd) {
	            e.fd = fd;
	        }
	
	        if(workerCtx.onmessage) {
	            workerCtx.onmessage(e);
	        }
	
	        for (var i=0; i<workerCtx.eventHandlers['message'].length; i++) {
	        	workerCtx.eventHandlers['message'][i](e);
	        }
        }

        break;

    default:
        wwutil.debug('Received unexpected message: ' + util.inspect(msg));
        break;
    }
};

if (process.argv.length < 4) {
    throw new Error('usage: node worker.js <sock> <script>');
}

var sockPath = process.argv[2];
var scriptLoc = new wwutil.WorkerLocation(process.argv[3]);

// Connect to the parent process
var ws = new WebSocket('ws+unix://' + sockPath);
var ms = new wwutil.MsgStream(ws);

// Once we connect successfully, set up the rest of the world
ws.addListener('open', function() {
    // When we receive a message from the master, react and possibly
    // dispatch it to the worker context
    ms.addListener('msg', handleMessage);

    // Register for uncaught events for delivery to workerCtx.onerror
    process.addListener('uncaughtException', exceptionHandler);

    // Execute the worker
    vm.runInContext(scriptSource, workerCtxObj);
});

// Construct the Script object to host the worker's code
var scriptSource = undefined;
switch (scriptLoc.protocol) {
case 'file':
    // scriptSource = fs.readFileSync(path.join(process.cwd(), scriptLoc.pathname));
	scriptSource = fs.readFileSync(scriptLoc.pathname);
    break;

default:
    console.error('Cannot load script from unknown protocol \'' +
        scriptLoc.protocol);
    process.exit(1);
}

// Set up the context for the worker instance
var workerCtx = {};

// Context elements required for node.js
//
// XXX: There must be a better way to do this.
workerCtx.global = workerCtx;
workerCtx.process = process;
workerCtx.require = require;
workerCtx.console = console;
workerCtx.__filename = scriptLoc.pathname;
workerCtx.__dirname = path.dirname(scriptLoc.pathname);
workerCtx.setTimeout = setTimeout;
workerCtx.clearTimeout = clearTimeout;
workerCtx.setInterval = setInterval;
workerCtx.clearInterval = clearInterval;
workerCtx.Buffer = Buffer;
workerCtx.ArrayBuffer = ArrayBuffer;
workerCtx.DataView = DataView;
workerCtx.Int8Array = Int8Array;
workerCtx.Int16Array = Int16Array;
workerCtx.Int32Array = Int32Array;
workerCtx.Uint8Array = Uint8Array;
workerCtx.Uint16Array = Uint16Array;
workerCtx.Uint32Array = Uint32Array;
workerCtx.Float32Array = Float32Array;
workerCtx.Float64Array = Float64Array;

// Context elements required by the WebWorkers API spec
workerCtx.postMessage = function(msg) {
    ms.send([wwutil.MSGTYPE_USER, msg]);
};
workerCtx.self = workerCtx;
workerCtx.location = scriptLoc;
workerCtx.closing = false;
workerCtx.close = function() {
    process.exit(0);
};
workerCtx.eventHandlers = {"message": new Array()};
workerCtx.addEventListener = function(event, handler) {
    if (event in workerCtx.eventHandlers) {
        workerCtx.eventHandlers[event].push(handler);
    }
};
workerCtx.importScripts = function() {
    for (var i=0; i<arguments.length; i++) {
    	vm.runInContext(fs.readFileSync(path.join(process.cwd(), arguments[i])), workerCtxObj);
    }
};

// Context object for vm script api
var workerCtxObj = vm.createContext(workerCtx);
