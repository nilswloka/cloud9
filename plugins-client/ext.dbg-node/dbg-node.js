/**
 * node debugger Module for the Cloud9 IDE
 *
 * @copyright 2010, Ajax.org B.V.
 * @license GPLv3 <http://www.gnu.org/licenses/gpl.txt>
 */

/*global mdlDbgSources mdlDbgBreakpoints mdlDbgStack ide */

define(function(require, exports, module) {

var V8Debugger = require("v8debug/V8Debugger");
var WSV8DebuggerService = require("v8debug/WSV8DebuggerService");
var ide = require("core/ide");

var v8DebugClient = exports.v8DebugClient = function() {
};

(function() {
    this.$startDebugging = function() {
        var v8dbg = this.$v8dbg = new V8Debugger(0, this.$v8ds);
        this.$v8breakpoints = {};

        var onChangeRunning = this.onChangeRunning.bind(this);
        var onBreak = this.onBreak.bind(this);
        var onException = this.onException.bind(this);
        var onAfterCompile = this.onAfterCompile.bind(this);
        // register event listeners
        v8dbg.addEventListener("changeRunning", onChangeRunning);
        v8dbg.addEventListener("break", onBreak);
        v8dbg.addEventListener("exception", onException);
        v8dbg.addEventListener("afterCompile", onAfterCompile);

        this.setFrame(null);

        // on detach remove all event listeners
        this.removeListeners = function () {
            v8dbg.removeEventListener("changeRunning", onChangeRunning);
            v8dbg.removeEventListener("break", onBreak);
            v8dbg.removeEventListener("exception", onException);
            v8dbg.removeEventListener("afterCompile", onAfterCompile);
        };
    };

    this.attach = function() {
        var _self = this;
        var onAttach = function(err, dbgImpl) {
            ide.dispatchEvent("dbg.attached", {dbgImpl: dbgImpl});
            _self.onChangeRunning();
            _self.syncAfterAttach();
        };
        
        // wsv8debuggerservice still expects stuff to be here stringified
        var wrapInStringify = function (fn) {
            return function (ev) {
                fn(JSON.stringify(ev.message));
            };
        };

        // mock a nice socket here
        this.$v8ds = new WSV8DebuggerService({
            on: function (ev, fn) {
                if (ev !== "message") {
                    return console.error("WSV8DebuggerService mocked socket only supports 'message'");
                }
                
                ide.addEventListener("socketMessage", wrapInStringify(fn));
            },
            removeListener: function (ev, fn) {
                if (ev !== "message") {
                    return console.error("WSV8DebuggerService mocked socket only supports 'message'");
                }
                
                ide.removeEventListener("socketMessage", wrapInStringify(fn));
            },
            send: ide.send
        });

        this.$v8ds.attach(0, function() {
            _self.$startDebugging();
            onAttach(null, _self);
        });
    };

    this.syncAfterAttach = function () {
        var _self = this;
        _self.loadScripts(function() {
            _self.backtrace(function() {
                _self.updateBreakpoints(function() {
                    _self.$v8dbg.listbreakpoints(function(e){
                        _self.$handleDebugBreak(e.breakpoints);
                    });
                });
                ide.dispatchEvent("dbg.break", {frame: _self.activeFrame});
                _self.onChangeRunning();
            });
        });
    };

    this.detach = function(callback) {
        this.setFrame(null);
        if (!this.$v8dbg)
            return callback();

        this.$v8dbg = null;
        this.onChangeRunning();

        var _self = this;
        this.removeListeners();
        this.$v8ds.detach(0, function(err) {
            callback && callback(err);
            _self.$v8ds = null;
        });
    };

    this.setFrame = function(frame) {
        this.activeFrame = frame;
        ide.dispatchEvent("dbg.changeFrame", {data: frame});
    };

    this.onChangeRunning = function(e) {
        if (!this.$v8dbg) {
            this.state = null;
        } else {
            this.state = this.$v8dbg.isRunning() ? "running" : "stopped";
        }

        ide.dispatchEvent("dbg.changeState", {state: this.state});

        if (this.state != "stopped")
            this.setFrame(null);
    };

    this.onBreak = function(e) {
        var _self = this;
        this.backtrace(function() {
            ide.dispatchEvent("dbg.break", {frame: _self.activeFrame});
        });
    };

    this.onException = function(e) {
        var _self = this;
        this.backtrace(function() {
            ide.dispatchEvent("dbg.exception", {frame: _self.activeFrame, exception: e.exception});
        });
    };

    this.onAfterCompile = function(e) {
        var script = apf.getXml(this.$getScriptXml(e.data.script));
        var id = script.getAttribute("scriptid");
        var oldNode = mdlDbgSources.queryNode("//file[@scriptid='" + id + "']");
        if (oldNode)
            mdlDbgSources.removeXml(oldNode);
        mdlDbgSources.appendXml(script);
    };

    this.$handleDebugBreak = function(remoteBreakpoints) {
        var frame = this.activeFrame;
        if (!frame || !this.$v8dbg)
            return;
        var bp = remoteBreakpoints[0];
        if (bp.number != 1)
            return;

        var uibp = mdlDbgBreakpoints.queryNode("//breakpoint[@line='" +
            frame.getAttribute("line") +"' and @path='" +
            frame.getAttribute("scriptPath") + "']");

        if (uibp && uibp.getAttribute("enabled") == "true")
            return;

        this.$v8dbg.clearbreakpoint(1, function(){});
        this.continueScript();
    };

    // apf xml helpers
    var hasChildren = {
        "object": 8,
        "function": 4
    };

    this.stripPrefix = "";

    this.setStrip = function(stripPrefix) {
        this.stripPrefix = stripPrefix;
    };

    this.$strip = function(str) {
        if (!this.stripPrefix)
            return str;

        return str.indexOf(this.stripPrefix) === 0
            ? str.slice(this.stripPrefix.length)
            : str;
    };

    this.$getScriptXml = function(script) {
        return [
            "<file scriptid='", script.id,
            "' scriptname='", apf.escapeXML(script.name || "anonymous"),
            "' path='", apf.escapeXML(this.getLocalScriptPath(script)),
            "' text='", this.$strip(apf.escapeXML(script.text || "anonymous")),
            "' lineoffset='", script.lineOffset,
            "' debug='true' />"
        ].join("");
    };

    function getId(frame){
        return (frame.func.name || frame.func.inferredName || (frame.line + frame.position));
    }

    this.$isSameFrameset = function(xmlFrameSet, frameSet){
        if (xmlFrameSet.length != frameSet.length)
            return false;

        var xmlFirst = xmlFrameSet[0];
        var first    = frameSet[0];
        if (xmlFirst.getAttribute("scriptid") != first.func.scriptId)
            return false;
        if (xmlFirst.getAttribute("id") != getId(first))
            return false;
        //if (xmlFirst.selectNodes("vars/item").length != (1 + first.arguments.length + first.locals.length))
            //return false;

        //@todo check for ref?? might fail for 2 functions in the same file with the same name in a different context
        return true;
    };

    this.getScriptIdFromPath = function(path) {
        var script = mdlDbgSources.queryNode("//file[@path='" + path + "']");
        if (!script)
            return;
        return script.getAttribute("scriptid");
    };

    this.getScriptnameFromPath = function(path) {
        if (!path)
            return;
        var script = mdlDbgSources.queryNode("//file[@path='" + path + "']");
        if (script)
            return script.getAttribute("scriptname");
        // if script isn't added yet reconstruct it's name from ide.workspaceDir
        if (path.substring(0, ide.davPrefix.length) != ide.davPrefix)
            return path;
        path = path.substr(ide.davPrefix.length);
        if (ide.workspaceDir.slice(1, 3) == ":\\")
            path = path.replace(/\//g, "\\");
        return ide.workspaceDir + path;
    };

    this.getPathFromScriptId = function(scriptId) {
        var script = mdlDbgSources.queryNode("//file[@scriptid='" + scriptId + "']");
        if (!script)
            return;
        return script.getAttribute("path");
    };

    this.getLocalScriptPath = function(script) {
        var scriptName = script.name || ("-anonymous-" + script.id);
        if (scriptName.substring(0, ide.workspaceDir.length) == ide.workspaceDir)
            scriptName = ide.davPrefix + scriptName.substr(ide.workspaceDir.length);
        // windows paths come here independantly from vfs
        return scriptName.replace(/\\/g, "/");
    };

    this.$valueString = function(value) {
        switch (value.type) {
            case "undefined":
            case "null":
                return value.type;

            case "boolean":
            case "number":
            case "string":
                return value.value + "";

            case "object":
                return "[" + value.className + "]";

            case "function":
                return "function " + value.inferredName + "()";

            default:
                return value.type;
        }
    };

    this.$frameToString = function(frame) {
        var str     = [];
        var args    = frame.arguments;
        var argsStr = [];

        str.push(frame.func.name || frame.func.inferredName || "anonymous", "(");
        for (var i = 0, l = args.length; i < l; i++) {
            var arg = args[i];
            if (!arg.name)
                continue;
            argsStr.push(arg.name);
        }
        str.push(argsStr.join(", "), ")");
        return str.join("");
    };

    this.$serializeVariable = function(item, name) {
        var str = [
            "<item name='", apf.escapeXML(name || item.name),
            "' value='", apf.escapeXML(this.$valueString(item.value)),
            "' type='", item.value.type,
            "' ref='", typeof item.value.ref == "number" ? item.value.ref : item.value.handle,
            hasChildren[item.value.type] ? "' children='true" : "",
            "' />"
        ];
        return str.join("");
    };

    /**
     * Assumptions:
     *  - .index stays the same
     *  - sequence in the array stays the same
     *  - ref stays the same when stepping in the same context
     */
    this.$updateFrame = function(xmlFrame, frame){
        //With code insertion, line/column might change??
        xmlFrame.setAttribute("line", frame.line);
        xmlFrame.setAttribute("column", frame.column);

        var i, j, l;
        var vars  = xmlFrame.selectNodes("vars/item");
        var fVars = frame.arguments;
        for (i = 1, j = 0, l = fVars.length; j < l; j++) { //i = 1 to skin this
            if (fVars[j].name)
                this.$updateVar(vars[i++], fVars[j]);
        }
        fVars = frame.locals;
        for (j = 0, l = frame.locals.length; j < l; j++) {
            if (fVars[j].name !== ".arguments")
                this.$updateVar(vars[i++], fVars[j]);
        }

        //@todo not caring about globals/scopes right now
    };

    this.$updateVar = function(xmlVar, fVar){
        xmlVar.setAttribute("value", this.$valueString(fVar.value));
        xmlVar.setAttribute("type", fVar.value.type);
        xmlVar.setAttribute("ref", fVar.value.ref);
        apf.xmldb.setAttribute(xmlVar, "children", hasChildren[fVar.value.type] ? "true" : "false");
    };

    this.$buildFrame = function(frame, ref, xml){
        var script = ref(frame.script.ref);
        xml.push(
            "<frame index='", frame.index,
            "' name='", apf.escapeXML(apf.escapeXML(this.$frameToString(frame))),
            "' column='", frame.column,
            "' id='", getId(frame),
            "' ref='", frame.ref,
            "' line='", frame.line,
            "' script='", this.$strip(script.name),
            "' scriptPath='", this.getLocalScriptPath(script),
            "' scriptid='", frame.func.scriptId, //script.id,
            "'>"
        );
        xml.push("<vars>");

        var receiver = {
            name: "this",
            value: frame.receiver
        };
        xml.push(this.$serializeVariable(receiver));

        var j, l;
        for (j = 0, l = frame.arguments.length; j < l; j++) {
            if (frame.arguments[j].name)
                xml.push(this.$serializeVariable(frame.arguments[j]));
        }
        for (j = 0, l = frame.locals.length; j < l; j++) {
            if (frame.locals[j].name !== ".arguments")
                xml.push(this.$serializeVariable(frame.locals[j]));
        }
        xml.push("<globals />");
        xml.push("</vars>");

        xml.push("<scopes>");
        var scopes = frame.scopes;
        for (j = 0, l = scopes.length; j < l; j++) {
            var scope = scopes[j];
            xml.push("<scope index='",scope.index, "' type='", scope.type, "' />");
        }
        xml.push("</scopes>");

        xml.push("</frame>");
    };

    // used from other plugins
    /**
     * state of the debugged process
     *    null:  process doesn't exist
     *   'stopped':  paused on breakpoint
     *   'running':
     */
    this.state = null;

    this.loadScripts = function(callback) {
        var model = mdlDbgSources;
        var _self = this;
        this.$v8dbg.scripts(4, null, false, function(scripts) {
            var xml = [];
            for (var i = 0, l = scripts.length; i < l; i++) {
                var script = scripts[i];
                if (script.name && script.name.indexOf("chrome-extension://") === 0)
                    continue;
                xml.push(_self.$getScriptXml(script));
            }
            model.load("<sources>" + xml.join("") + "</sources>");
            callback();
        });
    };

    this.backtrace = function(callback) {
        var _self = this;
        var model = mdlDbgStack;
        this.$v8dbg.backtrace(null, null, null, true, function(body, refs) {
            function ref(id) {
                for (var i=0; i<refs.length; i++) {
                    if (refs[i].handle == id) {
                        return refs[i];
                    }
                }
                return {};
            }

            var i, l;
            var frames    = body.frames;
            var xmlFrames = model.queryNodes("frame");
            if (xmlFrames.length && _self.$isSameFrameset(xmlFrames, frames)) {
                for (i = 0, l = frames.length; i < l; i++)
                    _self.$updateFrame(xmlFrames[i], frames[i]);
            } else {
                var xml = [];
                if (frames) {
                    for (i = 0, l = frames.length; i < l; i++)
                        _self.$buildFrame(frames[i], ref, xml);
                }
                model.load("<frames>" + xml.join("") + "</frames>");
            }

            var topFrame = model.data.firstChild;
            topFrame && topFrame.setAttribute("istop", true);
            _self.setFrame(topFrame);
            callback();
        });
    };

    this.loadScript = function(script, callback) {
        var id = script.getAttribute("scriptid");
        var _self = this;
        this.$v8dbg.scripts(4, [id], true, function(scripts) {
            if (!scripts.length)
                return;
            var script = scripts[0];
            callback(script.source);
        });
    };

    this.loadObjects = function(item, callback) {
        var ref   = item.getAttribute("ref");
        var _self = this;
        this.$v8dbg.lookup([ref], false, function(body) {
            var refs  = [];
            var props = body[ref].properties;
            for (var i = 0, l = props.length; i < l; i++)
                refs.push(props[i].ref);

            _self.$v8dbg.lookup(refs, false, function(body) {
                var xml = ["<item>"];
                for (var i = 0, l = props.length; i < l; i++) {
                    props[i].value = body[props[i].ref];
                    xml.push(_self.$serializeVariable(props[i]));
                }
                xml.push("</item>");
                callback(xml.join(""));
            });
        });
    };

    this.loadFrame = function(frame, callback) {
        //var xml = "<vars><item name='juhu' value='42' type='number'/></vars>"
        var scopes = frame.getElementsByTagName("scope");

        var frameIndex = parseInt(frame.getAttribute("index"), 10);

        var _self     = this;
        var processed = 0;
        var expected  = 0;
        var xml       = ["<vars>"];
        function addFrame(body) {
            var props = body.object.properties;
            for (var j = 0, l2 = props.length; j < l2; j++)
                xml.push(_self.$serializeVariable(props[j]));
            processed += 1;
            if (processed == expected) {
                xml.push("</vars>");
                callback(xml.join(""));
            }
        }

        for (var i = 0, l = scopes.length; i < l; i++) {
            var scope = scopes[i];
            var type = parseInt(scope.getAttribute("type"), 10);

            // ignore local and global scope
            if (type > 1) {
                expected += 1;
                var index = parseInt(scope.getAttribute("index"), 10);
                this.$v8dbg.scope(index, frameIndex, true, addFrame);
            }
        }
        if (expected === 0)
            return callback("<vars />");
    };

    this.continueScript = function(stepaction, stepcount, callback) {
        this.$v8dbg.continueScript(stepaction, stepcount, callback);
    };

    this.suspend = function() {
        this.$v8dbg.suspend();
    };

    this.lookup = function(handles, includeSource, callback) {
        this.$v8dbg.lookup(handles, includeSource, callback);
    };

    this.changeLive = function(scriptId, newSource, previewOnly, callback) {
        var NODE_PREFIX = "(function (exports, require, module, __filename, __dirname) { ";
        var NODE_POSTFIX = "\n});";
        newSource = NODE_PREFIX + newSource + NODE_POSTFIX;
        var _self = this;
        this.$v8dbg.changelive(scriptId, newSource, previewOnly, function(e) {
            callback(e);
            _self.backtrace(function(){});
        });
    };

    this.evaluate = function(expression, frame, global, disableBreak, callback) {
        this.$v8dbg.evaluate(expression, frame, global, disableBreak, function(body, refs, error){
            var str = [];
            var name = expression.trim();
            if (error) {
                str.push("<item type='.error' name=\"", apf.escapeXML(name),
                    "\" value=\"", apf.escapeXML(error.message), "\" />");
            }
            else {
                str.push(
                    "<item name=\"", apf.escapeXML(name),
                    "\" value='", apf.escapeXML(body.text), //body.value ||
                    "' type='", body.type,
                    "' ref='", body.handle,
                    body.constructorFunction ? "' constructor='" + body.constructorFunction.ref : "",
                    body.prototypeObject ? "' prototype='" + body.prototypeObject.ref : "",
                    body.properties && body.properties.length ? "' children='true" : "",
                    "' />"
              );
            }
            callback(apf.getXml(str.join("")), body, refs, error);
        });
    };

    this.updateBreakpoints = function(callback) {
        var _self = this;

        // read all the breakpoints, then call the debugger to actually set them
        var uiBreakpoints = mdlDbgBreakpoints.queryNodes("breakpoint").map(function(bp) {
            return {
                path: bp.getAttribute("path") || "",
                line: parseInt(bp.getAttribute("line"), 10),
                column: parseInt(bp.getAttribute("column"), 10) || 0,
                enabled: bp.getAttribute("enabled") == "true",
                condition: bp.getAttribute("condition") || "",
                ignoreCount: bp.getAttribute("ignoreCount") || 0
            };
        });

        // keep track of all breakpoints and check if they're really added
        var counter = 0;

        var createdBreakpoints = this.$v8breakpoints;
        this.$v8breakpoints = {};

        uiBreakpoints.forEach(function(bp) {
            bp.scriptname = _self.getScriptnameFromPath(bp.path);
            if (!bp.scriptname)
                return;
            bp.$location = bp.scriptname + "|" + bp.line + ":" + bp.column;

            var oldBp = createdBreakpoints[bp.$location];

            // enabled doesn't work with v8debug so we just skip those
            if (!bp.enabled)
                return;

            delete createdBreakpoints[bp.$location];
            if (oldBp && isEqual(oldBp, bp)) {
                _self.$v8breakpoints[bp.$location] = oldBp;
            } else {
                _self.$v8breakpoints[bp.$location] = bp;
                addBp(bp);
            }
        });

        for (var i in createdBreakpoints)
            removeBp(createdBreakpoints[i]);

        function bpCallback(bp) {
            var location = bp.script_name + "|" + bp.line + ":" + (bp.column || 0);
            var uiBp = _self.$v8breakpoints[location];
            if (uiBp) {
                if (!uiBp.id || uiBp.id < bp.breakpoint) {
                    uiBp.id = bp.breakpoint;
                }
            }
            counter--;
            if (!counter)
                callback && callback();
        }

        function addBp(bp) {
            counter++;
            _self.$v8dbg.setbreakpoint("script", bp.scriptname, bp.line, bp.column, bp.enabled, bp.condition, bp.ignoreCount, bpCallback);
        }

        function removeBp(bp) {
            bp.id && _self.$v8dbg.clearbreakpoint(bp.id, function(){});
        }
        function isEqual(bp1, bp2) {
            return bp1.$location == bp2.$location && bp1.condition == bp2.condition && bp1.ignoreCount == bp2.ignoreCount;
        }

        if (!counter)
            callback && callback();
    };

}).call(v8DebugClient.prototype);


ide.addEventListener("dbg.ready", function(e) {
    if (e.type == "node-debug-ready") {
        if (!exports.dbgImpl) {
            exports.dbgImpl = new v8DebugClient();
            exports.dbgImpl.attach();
        }
    }
});

ide.addEventListener("dbg.exit", function(e) {
    if (exports.dbgImpl) {
        exports.dbgImpl.detach();
        exports.dbgImpl = null;
    }
});

ide.addEventListener("dbg.state", function(e) {
    if (e["node-debug"] && !exports.dbgImpl) {
        exports.dbgImpl = new v8DebugClient();
        exports.dbgImpl.attach();
    }
});

});
