/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

"use strict";

(function() {

const { base, kiri } = self;
const { paths, util, newPoint, Polygon } = base;
const { tip2tipEmit } = paths;

kiri.newPrint = function(settings, widgets, id) {
    return new Print(settings, widgets, id);
};

class Print {
    constructor(settings, widgets, id) {
        this.id = id || new Date().getTime().toString(36);
        this.settings = settings;
        this.widgets = widgets;
        this.lastPoint = null;
        this.lastEmit = null;
        this.lastOut = null;
        this.lastPos = null;
        this.tools = {};
        // set to 1 to enable flow rate analysis (console)
        this.debugE = settings ? (settings.controller.devel ? 1 : 0) : 0;
    }

    setType(type) {
        this.nextType = type;
    }

    addOutput(array, point, emit, speed, tool) {
        let { lastPoint, lastEmit, lastOut } = this;
        // drop duplicates (usually intruced by FDM bisections)
        if (lastPoint && point) {
            // nested due to uglify confusing browser
            const { x, y, z } = lastPoint;
            if (point.x == x && point.y == y && point.z == z && lastEmit == emit) {
                return lastOut;
            }
        }
        // if (emit && emit < 1) console.log(emit);
        this.lastPoint = point;
        this.lastEmit = emit;
        this.lastOut = lastOut = new Output(point, emit, speed, tool, this.nextType);
        if (tool !== undefined) {
            this.tools[tool] = true;
        }
        array.push(lastOut);
        this.nextType = undefined;
        return lastOut;
    }

    addPrintPoints(input, output, startPoint, tool) {
        if (this.startPoint && input.length > 0) {
            this.lastPoint = this.startPoint;
            // TODO: revisit seek to origin as the first move
            // addOutput(output, startPoint, 0, undefined, tool);
        }
        output.appendAll(input);
    }

    // fdm & laser
    polyPrintPath(poly, startPoint, output, options = {}) {
        poly.setClockwise();

        const scope = this;
        const { settings } = scope;
        const { process } = settings;

        let shortDist = process.outputShortDistance,
            shellMult = pref(options.extrude, process.outputShellMult),
            printSpeed = options.rate || process.outputFeedrate,
            moveSpeed = process.outputSeekrate,
            minSpeed = process.outputMinSpeed,
            coastDist = options.coast || 0,
            closest = options.simple ? poly.first() : poly.findClosestPointTo(startPoint),
            perimeter = poly.perimeter(),
            close = !options.open,
            tool = options.tool,
            last = startPoint,
            first = true;

        // if short, use calculated print speed based on sliding scale
        if (perimeter < process.outputShortPoly) {
            printSpeed = minSpeed + (printSpeed - minSpeed) * (perimeter / process.outputShortPoly);
        }

        poly.forEachPoint((point, pos, points, count) => {
            if (first) {
                if (options.onfirst) {
                    options.onfirst(point);
                }
                // move to first output point on poly
                let out = scope.addOutput(output, point, 0, moveSpeed, tool);
                if (options.onfirstout) {
                    options.onfirstout(out);
                }
                first = false;
            } else {
                let seglen = last.distTo2D(point);
                if (coastDist && shellMult && perimeter - seglen <= coastDist) {
                    let delta = perimeter - coastDist;
                    let offset = seglen - delta;
                    let offPoint = last.offsetPointFrom(point, offset)
                    scope.addOutput(output, offPoint, shellMult, printSpeed, tool);
                    shellMult = 0;
                }
                perimeter -= seglen;
                scope.addOutput(output, point, shellMult, printSpeed, tool);
            }
            last = point;
        }, close, closest.index);

        return output.last().point;
    }

    extrudePerMM(noz, fil, slice) {
        return ((Math.PI * util.sqr(noz / 2)) / (Math.PI * util.sqr(fil / 2))) * (slice / noz);
    }

    constReplace(str, consts, start, pad, short) {
        let cs = str.indexOf("{", start || 0),
            ce = str.indexOf("}", cs),
            tok, nutok, nustr;
        if (cs >=0 && ce > cs) {
            tok = str.substring(cs+1,ce);
            let eva = [];
            for (let [k,v] of Object.entries(consts)) {
                switch (typeof v) {
                    case 'number':
                    case 'boolean':
                        eva.push(`let ${k} = ${v};`);
                        break;
                    default:
                        if (v === undefined) v = '';
                        eva.push(`let ${k} = "${v.replace(/\"/g,"\\\"")}";`);
                        break;
                }
            }
            eva.push(`function range(a,b) { return (a + (layer / layers) * (b-a)).round(4) }`)
            eva.push(`try {( ${tok} )} catch (e) {console.log(e);0}`);
            let scr = eva.join('');
            let evl = eval(`{ ${scr} }`);
            nutok = evl;
            if (pad === 666) {
                return evl;
            }
            if (pad) {
                nutok = nutok.toString();
                let oldln = ce-cs+1;
                let tokln = nutok.length;
                if (tokln < oldln) {
                    short = (short || 1) + (oldln - tokln);
                }
            }
            nustr = str.replace("{"+tok+"}",nutok);
            return this.constReplace(nustr, consts, ce+1+(nustr.length-str.length), pad, short);
        } else {
            // insert compensating spaces for accumulated replace string shortages
            if (short) {
                let si = str.indexOf(';');
                if (si > 0) {
                    str = str.replace(';', ';'.padStart(short,' '));
                }
            }
            return str;
        }
    }

    // fdm only
    slicePrintPath(slice, startPoint, offset, output, opt = {}) {
        const scope = this;
        const { settings } = scope;
        const { device } = settings;

        // console.log({slicePrintPath: slice.index, ext:slice.extruder});
        let i,
            preout = [],
            process = opt.params || settings.process,
            extruder = slice.extruder || 0,
            nozzleSize = device.extruders[extruder].extNozzle,
            firstLayer = opt.first || false,
            thinWall = nozzleSize * (opt.thinWall || 1.75),
            retractDist = opt.retractOver || 2,
            solidWidth = process.sliceFillWidth || 1,
            fillMult = opt.mult || process.outputFillMult,
            shellMult = opt.mult || process.outputShellMult || (process.laserSliceHeight >= 0 ? 1 : 0),
            shellOrder = {"out-in":-1,"in-out":1}[process.sliceShellOrder] || -1,
            sparseMult = process.outputSparseMult,
            coastDist = process.outputCoastDist || 0,
            finishSpeed = opt.speed || process.outputFinishrate,
            firstShellSpeed = process.firstLayerRate,
            firstFillSpeed = process.firstLayerFillRate,
            firstPrintMult = process.firstLayerPrintMult,
            printSpeed = opt.speed || (firstLayer ? firstShellSpeed : process.outputFeedrate),
            fillSpeed = opt.speed || opt.fillSpeed || (firstLayer ? firstFillSpeed || firstShellSpeed : process.outputFeedrate),
            infillSpeed = process.sliceFillRate || opt.infillSpeed || fillSpeed || printSpeed,
            moveSpeed = process.outputSeekrate,
            origin = startPoint.add(offset),
            zhop = process.zHopDistance || 0,
            antiBacklash = process.antiBacklash,
            wipeDist = process.outputRetractWipe || 0,
            isBelt = device.bedBelt,
            beltFirst = process.outputBeltFirst || false,
            startClone = startPoint.clone(),
            seedPoint = opt.seedPoint || startPoint,
            z = slice.z,
            lastPoly;

        // apply first layer extrusion multipliers
        if (firstLayer) {
            fillMult *= firstPrintMult;
            shellMult *= firstPrintMult;
            sparseMult *= firstPrintMult;
        }

        function retract() {
            let array = preout.length ? preout : output;
            if (array.length) {
                let last = array.last();
                last.retract = true;
                if (wipeDist && lastPoly && last.point) {
                    let endpoint = last.point.followTo(lastPoly.center(true), wipeDist);
                    if (endpoint.inPolygon(lastPoly)) {
                        scope.addOutput(array, endpoint);
                    }
                }
            } else if (opt.pretract) {
                opt.pretract(wipeDist);
            } else {
                console.log('unable to retract. no preout or output');
            }
        }

        function intersectsTop(p1, p2) {
            if (slice.index < 0) {
                return false;
            }
            let int = false;
            slice.topPolysFlat().forEach((poly) => {
                if (!int) poly.forEachSegment((s1, s2) => {
                    if (util.intersect(p1,p2,s1,s2,base.key.SEGINT)) {
                        return int = true;
                    }
                });
            });
            // if intersecting, look for a route around
            if (int && opt.routeAround) {
                return !routeAround(p1, p2);
            }
            return int;
        }

        // returns true if routed around or no retract requried
        function routeAround(p1, p2) {
            const dbug = false;
            if (dbug === slice.index) console.log(slice.index, {p1, p2, d: p1.distTo2D(p2)});

            let ints = [];
            let tops = slice.topRouteFlat();
            for (let poly of tops) {
                poly.forEachSegment((s1, s2) => {
                    let ip = util.intersect(p1,p2,s1,s2,base.key.SEGINT);
                    if (ip) {
                        ints.push({ip, poly});
                    }
                });
            }

            // no intersections
            if (ints.length === 0) {
                if (dbug === slice.index) console.log(slice.index, 'no ints');
                return false;
            }

            // odd # of intersections ?!? do retraction
            if (ints.length && ints.length % 2 !== 0) {
                if (dbug === slice.index) console.log(slice.index, {odd_intersects: ints});
                return false;
            }

            // sort by distance
            ints.sort((a, b) => {
                return a.ip.dist - b.ip.dist;
            });

            if (dbug === slice.index) console.log(slice.index, {ints});

            // check pairs. eliminate too close points.
            // pairs must intersect same poly or retract.
            for (let i=0; i<ints.length; i += 2) {
                let i1 = ints[i];
                let i2 = ints[i+1];
                // different poly. force retract
                if (i1.poly !== i2.poly) {
                    if (dbug === slice.index) console.log(slice.index, {int_diff_poly: ints, i});
                    return false;
                }
                // mark invalid intersect pairs (low or zero dist, etc)
                // TODO: only if this is the outer pair and there are closer inner pairs
                if (i1.ip.distTo2D(i2.ip) < retractDist) {
                    if (dbug === slice.index) console.log(slice.index, {int_dist_too_small: i1.ip.distTo2D(i2.ip), retractDist});
                    ints[i] = undefined;
                    ints[i+1] = undefined;
                }
            }
            // filter out invalid intersection pairs
            ints = ints.filter(i => i);

            if (ints.length > 2) {
                if (dbug === slice.index) console.log(slice.index, {complex_route: ints.length});
                return false;
            }

            if (ints.length === 2) {
                // can route around intersected top polys
                for (let i=0; i<ints.length; i += 2) {
                    let i1 = ints[0];
                    let i2 = ints[1];

                    // output first point
                    scope.addOutput(preout, i1.ip, 0, moveSpeed, extruder);

                    // create two loops around poly
                    // find shortest of two paths and emit poly points
                    let poly = i1.poly;
                    let isCW = poly.isClockwise();
                    let points = poly.points;

                    let p1p = isCW ? points : points.slice().reverse(); // CW
                    let p2p = isCW ? points.slice().reverse() : points; // CCW

                    let r1s = p1p.indexOf(isCW ? i1.ip.p2 : i1.ip.p1);
                    let r1e = p1p.indexOf(isCW ? i2.ip.p1 : i2.ip.p2);

                    let r1 = r1s === r1e ?
                        [ p1p[r1s] ] : r1s < r1e ?
                        [ ...p1p.slice(r1s,r1e+1) ] :
                        [ ...p1p.slice(r1s), ...p1p.slice(0,r1e+1) ];

                    let r1d = 0;
                    for (let i=1; i<r1.length; i++) {
                        r1d += r1[i-1].distTo2D(r1[i]);
                    }

                    let r2s = p2p.indexOf(isCW ? i1.ip.p1 : i1.ip.p2);
                    let r2e = p2p.indexOf(isCW ? i2.ip.p2 : i2.ip.p1);

                    let r2 = r2s === r2e ?
                        [ p2p[r2s] ] : r2s < r2e ?
                        [ ...p2p.slice(r2s,r2e+1) ] :
                        [ ...p2p.slice(r2s), ...p2p.slice(0,r2e+1) ];

                    let r2d = 0;
                    for (let i=1; i<r2.length; i++) {
                        r2d += r2[i-1].distTo2D(r2[i]);
                    }

                    let route = r1d <= r2d ? r1 : r2;

                    if (dbug === slice.index) console.log(slice.index, {
                        ints: ints.map(i=>i.ip.dist),
                        i1, i2, same: i1.poly === i2.poly,
                        route,
                        p1, p2, dist: p1.distTo2D(p2),
                        r1, r1d, r1s, r1e,
                        r2, r2d, r2s, r2e,
                        isCW});

                    for (let p of route) {
                        scope.addOutput(preout, p, 0, moveSpeed, extruder);
                    }

                    // output last point
                    scope.addOutput(preout, i2.ip, 0, moveSpeed, extruder);
                }
                return true;
            }

            return false;
        }

        function outputTraces(poly, opt = {}) {
            if (!poly) return;
            if (Array.isArray(poly)) {
                if (opt.sort) {
                    let polys = poly.slice().sort((a,b) => {
                        return (a.perimeter() - b.perimeter()) * opt.sort;
                    });
                    let debug = polys.length > 3;
                    let last;
                    while (polys.length) {
                        let next;
                        for (let p of polys) {
                            if (!last) {
                                next = p;
                                break;
                            }
                            if (opt.sort > 0) {
                                // in-out
                                if (last.isInside(p)) {
                                    next = p;
                                    break;
                                }
                            } else {
                                // out-in
                                if (p.isInside(last)) {
                                    next = p;
                                    break;
                                }
                            }
                        }
                        if (next) {
                            last = next;
                            polys.remove(next);
                            outputTraces(next, opt);
                        } else {
                            last = null;
                        }
                    }
                } else {
                    outputOrderClosest(poly, function(next) {
                        outputTraces(next, opt);
                    }, null);
                }
            } else {
                let finishShell = poly.depth === 0 && !firstLayer;
                startPoint = scope.polyPrintPath(poly, startPoint, preout, {
                    tool: extruder,
                    rate: finishShell ? finishSpeed : printSpeed,
                    accel: finishShell,
                    wipe: process.outputWipeDistance || 0,
                    coast: firstLayer ? 0 : coastDist,
                    extrude: pref(opt.extrude, shellMult),
                    onfirst: function(firstPoint) {
                        let from = seedPoint || startPoint;
                        if (from.distTo2D(firstPoint) > retractDist) {
                            if (intersectsTop(from, firstPoint)) {
                                retract();
                            }
                        }
                        seedPoint = null;
                    }
                });
                lastPoly = slice.lastPoly = poly;
            }
        }

        /**
         * @param {Polygon[]} polys
         */
        function outputSparse(polys, extrude, speed) {
            if (!polys) return;
            let proxy = polys.map((poly) => {
                return {poly: poly, first: poly.first(), last: poly.last()};
            });
            let lp = startPoint;
            startPoint = tip2tipEmit(proxy, startPoint, (el, point, count) => {
                let poly = el.poly;
                if (poly.last() === point) {
                    poly.reverse();
                }
                poly.forEachPoint((p, i) => {
                    let dist = lp.distTo2D(p);
                    let rdst = dist > retractDist;
                    let itop = rdst && intersectsTop(lp,p);
                    let emit = extrude;
                    // retract if dist trigger and crosses a slice top polygon
                    if (i === 0) {
                        if (itop) {
                            retract();
                            emit = 0;
                        } else if (dist > nozzleSize) {
                            emit = 0;
                        }
                    }
                    // let emit = i === 0 ? 0 : extrude;
                    // handle shallow cloned infill
                    if (poly.z !== undefined) {
                        p = p.clone().setZ(poly.z);
                    }
                    scope.addOutput(preout, p, emit, speed || printSpeed, extruder);
                    lp = p;
                }, !poly.open);
                return lp;
            });
        }

        function outputThin(lines) {
            if (!lines) {
                return;
            }
            let points = lines.group(2).map(grp => {
                let [ p1, p2 ] = grp;
                return newPoint(
                    (p1.x + p2.x) / 2,
                    (p1.y + p2.y) / 2,
                    (p1.z + p2.z) / 2
                )
            });
            let order = util.orderClosest(points, (p1, p2) => p1.distTo2D(p2));
            if (order.length === 0) {
                return;
            }
            let first = points[0];
            let last = first;
            scope.addOutput(preout, first, 0, moveSpeed, extruder);
            for (let p of order) {
                let dist = last ? last.distTo2D(p) : 0;
                if (dist > thinWall) {
                    retract();
                    scope.addOutput(preout, p, 0, moveSpeed, extruder);
                }
                scope.addOutput(preout, p, 1, fillSpeed, extruder);
                last = p;
            }
            // close a circle
            if (last && last.distTo2D(first) <= thinWall) {
                scope.addOutput(preout, first, 1, fillSpeed, extruder);
            }
        }

        function outputFills(lines, opt = {}) {
            if (!lines || lines.length === 0) {
                return;
            }
            let p, p1, p2, dist, len, found, group, mindist, t1, t2,
                marked = 0,
                start = 0,
                skip = false,
                lastIndex = -1,
                flow = opt.flow || 1,
                near = opt.near || false,
                fast = opt.fast || false,
                fill = (opt.fill >= 0 ? opt.fill : fillMult) * flow,
                thinDist = near ? thinWall : thinWall;

            while (lines && marked < lines.length) {
                group = null;
                found = false;
                mindist = Infinity;

                // use next nearest line strategy
                if (near)
                for (i=0; i<lines.length; i += 2) {
                    t1 = lines[i];
                    if (t1.del) {
                        continue;
                    }
                    t2 = lines[i+1];
                    let d1 = t1.distToSq2D(startPoint);
                    let d2 = t2.distToSq2D(startPoint);
                    if (d1 < mindist || d2 < mindist) {
                        if (d2 < d1) {
                            p2 = t1;
                            p1 = t2;
                        } else {
                            p1 = t1;
                            p2 = t2;
                        }
                        mindist = Math.min(d1, d2);
                        lastIndex = i;
                    }
                }

                // use next index line strategy
                // order all points by distance to last point
                if (!near)
                for (i=start; i<lines.length; i += 2) {
                    p = lines[i];
                    if (p.del) {
                        continue;
                    }
                    if (group === null && p.index > lastIndex) {
                        group = p.index;
                    }
                    if (group !== null) {
                        if (p.index !== group) {
                            break;
                        }
                        if (p.index % 2 === 0) {
                            t1 = lines[i];
                            t2 = lines[i+1];
                        } else {
                            t2 = lines[i];
                            t1 = lines[i+1];
                        }
                        dist = Math.min(t1.distTo2D(startPoint), t2.distTo2D(startPoint));
                        if (dist < mindist) {
                            p1 = t1;
                            p2 = t2;
                            mindist = dist;
                        }
                        start = i;
                        found = true;
                    }
                }

                // go back to start and try again
                if (!near && !found) {
                    if (start === 0 && lastIndex === -1) {
                        console.log('infinite loop', lines, {
                            marked, i, group, start, lastIndex,
                            points: lines.map(p => p.index).join(', ')
                        });
                        break;
                    }
                    start = 0;
                    lastIndex = -1;
                    continue;
                }

                dist = startPoint.distToSq2D(p1);
                len = p1.distToSq2D(p2);

                // go back to start when dist > retractDist
                if (!near && !fast && !skip && dist > retractDist) {
                    skip = true;
                    start = 0;
                    lastIndex = -1;
                    continue;
                }
                skip = false;

                // mark as used (temporarily)
                p1.del = true;
                p2.del = true;
                marked += 2;
                lastIndex = p1.index;

                // if dist to new segment is less than thinWall
                // and segment length is less than thinWall then
                // just extrude to midpoint of next segment. this is
                // to avoid shaking the printer to death.
                if (dist <= thinDist && len <= thinDist) {
                    p2 = p1.midPointTo(p2);
                    // this.addOutput(preout, p2, fill * (dist / thinWall), fillSpeed, extruder);
                    scope.addOutput(preout, p2, fill, fillSpeed, extruder);
                } else {
                    // retract if dist trigger or crosses a slice top polygon
                    if (!fast && dist > retractDist && (zhop || intersectsTop(startPoint, p1))) {
                        retract();
                    }

                    // anti-backlash on longer move
                    if (!fast && antiBacklash && dist > retractDist) {
                        scope.addOutput(preout, p1.add({x:antiBacklash,y:-antiBacklash,z:0}), 0, moveSpeed, extruder);
                    }

                    // bridge ends of fill when they're close together
                    if (dist < thinDist) {
                        scope.addOutput(preout, p1, fill, fillSpeed, extruder);
                    } else {
                        scope.addOutput(preout, p1, 0, moveSpeed, extruder);
                    }

                    scope.addOutput(preout, p2, fill, fillSpeed, extruder);
                }

                startPoint = p2;
            }

            // clear delete marks so we can re-print later
            if (lines) lines.forEach(p => { p.del = false });
        }

        /**
         * given array of polygons, emit them in next closest order with
         * the special exception that depth is considered into distance
         * so that inner polygons are emitted first.
         *
         * @param {Array} array of Polygons or Polygon wrappers (tops)
         * @param {Function} fn call to emit next candidate
         * @param {Function} fnp convert 'next' object into a Polygon for closeness
         */
        function outputOrderClosest(array, fn, fnp) {
            if (array.length === 1) {
                return fn(array[0]);
            }
            array = array.slice();
            let closest, find, next, order, poly, lastDepth = 0;
            for (;;) {
                order = [];
                closest = null;
                for (i=0; i<array.length; i++) {
                    next = array[i];
                    if (!next) continue;
                    poly = fnp ? fnp(next) : next;
                    find = poly.findClosestPointTo(startPoint);
                    order.push({
                        i: i,
                        n: next,
                        d: find.distance - (poly.depth * thinWall),
                    });
                }
                if (order.length === 0) {
                    return;
                }
                order.sort((a,b) => {
                    return a.d - b.d;
                });
                array[order[0].i] = null;
                fn(order[0].n);
            }
        }

        let out = [];
        if (slice.tops) {
            out.appendAll(slice.tops);
        };
        if (opt.support && slice.supports) {
            out.appendAll(slice.supports);
        }

        let lastTop = null;
        outputOrderClosest(out, function(next) {
            if (next instanceof Polygon) {
                scope.setType('support');
                // support polygon
                next.setZ(z);
                outputTraces([next].appendAll(next.inner || []));
                if (next.fill) {
                    next.fill.forEach(p => { p.z = z });
                    outputFills(next.fill, {fast: true});
                }
            } else {
                scope.setType('shells');
                if (lastTop && lastTop !== next) {
                    retract();
                }

                // control of layer start point
                switch (process.sliceLayerStart) {
                    case "center":
                        startPoint = newPoint(0,0,startPoint.z);
                        break;
                    case "origin":
                        startPoint = origin.clone();
                        break;
                }

                // optimize start point on belt for tops touching belt
                // and enforce optimal shell order (outer first)
                if (isBelt && opt.onBelt) {
                    startPoint = startClone;
                    if (beltFirst) {
                        shellOrder = -1;
                    }
                }

                // innermost shells
                let inner = next.innerShells() || [];

                // output inner polygons
                if (shellOrder === 1) outputTraces(inner, { sort: shellOrder });

                outputTraces(next.shells, { sort: shellOrder });

                // output outer polygons
                if (shellOrder === -1) outputTraces(inner, { sort: shellOrder });

                // output thin fill
                scope.setType('thin fill');
                outputThin(next.thin_fill);

                // then output solid and sparse fill
                scope.setType('solid fill');
                outputFills(next.fill_lines, {flow: solidWidth});

                scope.setType('sparse infill');
                outputSparse(next.fill_sparse, sparseMult, infillSpeed);

                lastTop = next;
            }
        }, function(obj) {
            // for tops
            return obj instanceof Polygon ? obj : obj.poly;
        });

        // produce polishing paths when present
        if (slice.tops.length && slice.tops[0].polish) {
            let {x,y} = slice.tops[0].polish;
            if (x) {
                outputSparse(x, 0, process.polishSpeed);
            }
            if (y) {
                outputSparse(y, 0, process.polishSpeed);
            }
        }

        // offset print points
        for (i=0; i<preout.length; i++) {
            preout[i].point = preout[i].point.add(offset);
        }

        // add offset points to total print
        this.addPrintPoints(preout, output, origin, extruder);

        return startPoint.add(offset);
    }

    parseSVG(code, offset) {
        let scope = this,
            svg = new DOMParser().parseFromString(code, 'text/xml'),
            lines = [...svg.getElementsByTagName('polyline')],
            output = scope.output = [],
            bounds = scope.bounds = {
                max: { x:-Infinity, y:-Infinity, z:-Infinity},
                min: { x:Infinity, y:Infinity, z:Infinity}
            };
        lines.forEach(line => {
            let seq = [];
            let points = [...line.points];
            points.forEach(point => {
                if (offset) {
                    point.x += offset.x;
                    point.y += offset.y;
                }
                if (point.x) bounds.min.x = Math.min(bounds.min.x, point.x);
                if (point.x) bounds.max.x = Math.max(bounds.max.x, point.x);
                if (point.y) bounds.min.y = Math.min(bounds.min.y, point.y);
                if (point.y) bounds.max.y = Math.max(bounds.max.y, point.y);
                if (point.z) bounds.min.z = Math.min(bounds.min.z, point.z);
                if (point.z) bounds.max.z = Math.max(bounds.max.z, point.z);
                const { x, y, z } = point; // SVGPoint is not serializable
                scope.addOutput(seq, { x, y, z }, seq.length > 0);
            });
            output.push(seq);
        });
        scope.imported = code;
        scope.lines = lines.length;
        scope.bytes = code.length;
        return scope.output;
    };

    parseGCode(gcode, offset, progress, done, opts = {}) {
        const fdm = opts.fdm;
        const belt = opts.belt;
        const lines = gcode
            .toUpperCase()
            .replace("X", " X")
            .replace("Y", " Y")
            .replace("Z", " Z")
            .replace("E", " E")
            .replace("F", " F")
            .replace("  ", " ")
            .split("\n");

        const scope = this,
            // morph = false,
            morph = true,
            bounds = scope.bounds = {
                max: { x:-Infinity, y:-Infinity, z:-Infinity},
                min: { x:Infinity, y:Infinity, z:Infinity}
            },
            pos = {
                X: 0.0,
                Y: 0.0,
                Z: 0.0,
                F: 0.0,
                E: 0.0
            },
            off = {
                X: offset ? offset.x || 0 : 0,
                Y: offset ? offset.y || 0 : 0,
                Z: offset ? offset.z || 0 : 0
            },
            xoff = {
                X: 0,
                Y: 0,
                Z: 0
            };

        let dz = 0,
            abs = true,
            absE = true,
            defh = 0,
            height = 0,
            factor = 1,
            tool = 0,
            minf = Infinity,
            maxf = 0,
            seq = [],
            autolayer = true,
            newlayer = false,
            arcdivs = Math.PI / 24,
            hasmoved = false;

        const output = scope.output = [ seq ];
        const beltaxis = { X: "X", Y: "Z", Z: "Y", E: "E", F: "F" };
        const beltfact = Math.cos(Math.PI / 4);

        function LOG() {
            console.log(...[...arguments].map(o => Object.clone(o)));
        }

        function G2G3(g2, line) {
            const rec = {};

            line.forEach(tok => {
                rec[tok.charAt(0)] = parseFloat(tok.substring(1));
            });

            let center = { x:0, y:0, r:0 };

            if (rec.I !== undefined && rec.J !== undefined) {
                center.x = pos.X + rec.I;
                center.y = pos.Y + rec.J;
                center.r = Math.sqrt(rec.I*rec.I + rec.J*rec.J);
            } else if (rec.R !== undefined) {
                let pd = { x: rec.X - pos.X, y: rec.Y - pos.Y };
                let dst = Math.sqrt(pd.x * pd.x + pd.y * pd.y) / 2;
                let pr2;
                if (Math.abs(dst - rec.R) < 0.001) {
                    // center point radius
                    pr2 = { x: (rec.X + pos.X) / 2, y: (rec.Y + pos.Y) / 2};
                } else {
                    // triangulate
                    pr2 = base.util.center2pr({
                        x: pos.X,
                        y: pos.Y
                    }, {
                        x: rec.X,
                        y: rec.Y
                    }, rec.R, g2);
                }
                center.x = pr2.x;
                center.y = pr2.y;
                center.r = rec.R;
            } else {
                console.log({malfomed_arc: line});
            }

            // line angles
            let a1 = Math.atan2(center.y - pos.Y, center.x - pos.X) + Math.PI;
            let a2 = Math.atan2(center.y - rec.Y, center.x - rec.X) + Math.PI;
            let ad = base.util.thetaDiff(a1, a2, g2);
            let steps = Math.max(Math.floor(Math.abs(ad) / arcdivs), 3);
            let step = (Math.abs(ad) > 0.001 ? ad : Math.PI * 2) / steps;
            let rot = a1 + step;

            // LOG({first: pos, last: rec, center, a1, a2, ad, step, rot, line});
            // G0G1(false, [`X${center.x}`, `Y${center.y}`, `E1`]);

            let pc = { X: pos.X, Y: pos.Y };
            for (let i=0; i<=steps-2; i++) {
                let np = {
                    X: center.x + Math.cos(rot) * center.r,
                    Y: center.y + Math.sin(rot) * center.r
                };
                rot += step;
                G0G1(false, [`X${np.X}`, `Y${np.Y}`, `E1`]);
            }

            G0G1(false, [`X${rec.X}`, `Y${rec.Y}`, `E1`]);

            pos.X = rec.X;
            pos.Y = rec.Y;
        }

        function G0G1(g0, line) {
            const mov = {};
            const axes = {};

            line.forEach(tok => {
                let axis = tok.charAt(0);
                if (morph && belt) {
                    axis = beltaxis[axis];
                }
                let val = parseFloat(tok.substring(1));
                axes[axis] = val;
                if (abs) {
                    pos[axis] = val;
                } else {
                    mov[axis] = val;
                    pos[axis] += val;
                }
            });

            const point = newPoint(
                factor * pos.X + off.X + xoff.X,
                factor * pos.Y + off.Y + xoff.Y,
                factor * pos.Z + off.Z + xoff.Z + dz
            );

            if (morph && belt) {
                point.y -= point.z * beltfact;
                point.z *= beltfact;
            }

            const retract = (fdm && pos.E < 0) || undefined;
            const moving = g0 || (fdm && (pos.E <= 0 || !(axes.X || axes.Y || axes.Z)));

            if (!moving && point.x) bounds.min.x = Math.min(bounds.min.x, point.x);
            if (!moving && point.x) bounds.max.x = Math.max(bounds.max.x, point.x);
            if (!moving && point.y) bounds.min.y = Math.min(bounds.min.y, point.y);
            if (!moving && point.y) bounds.max.y = Math.max(bounds.max.y, point.y);
            if (!moving && point.z) bounds.min.z = Math.min(bounds.min.z, point.z);
            if (!moving && point.z) bounds.max.z = Math.max(bounds.max.z, point.z);

            // update max speed
            if (pos.F) minf = Math.min(minf, pos.F);
            maxf = Math.max(maxf, pos.F);

            // always add moves to the current sequence
            if (moving) {
                scope.addOutput(seq, point, false, pos.F, tool).retract = retract;
                scope.lastPos = Object.assign({}, pos);
                return;
            }

            if (seq.Z === undefined) {
                seq.Z = pos.Z;
            }

            if (fdm && height === 0) {
                seq.height = defh = height = pos.Z;
            }

            // non-move in a new plane means burp out
            // the old sequence and start a new one
            if (newlayer || (autolayer && seq.Z != pos.Z)) {
                newlayer = false;
                let nh = (defh || pos.Z - seq.Z);
                seq = [];
                seq.height = height = nh;
                if (fdm) dz = -height / 2;
                output.push(seq);
            }

            if (!hasmoved && !moving) {
                seq.height = seq.Z = pos.Z;
                hasmoved = true;
            }

            // debug extrusion rate
            const lastPos = scope.lastPos;
            if (scope.debugE && fdm && lastPos && pos.E) {
                // extruder move
                let dE = (absE ? pos.E - scope.lastPosE : pos.E);
                // distance moved in XY
                let dV = Math.sqrt(
                    (Math.pow(pos.X - lastPos.X, 2)) +
                    (Math.pow(pos.Y - lastPos.Y, 2))
                );
                // filament per mm
                let dR = (dE / dV);
                if (dV > 2 && dE > 0.001) {
                    let lab = (absE ? 'aA' : 'rR')[scope.debugE++ % 2];
                    console.log(lab, height.toFixed(2), dV.toFixed(2), dE.toFixed(3), dR.toFixed(4), pos.F.toFixed(0));
                }
            }
            // add point to current sequence
            scope.addOutput(seq, point, true, pos.F, tool).retract = retract;
            scope.lastPos = Object.assign({}, pos);
            scope.lastPosE = pos.E;
        }

        lines.forEach((line, idx) => {
            if (line.indexOf(';LAYER:') === 0) {
                newlayer = true;
                autolayer = false;
            }
            if (line.indexOf('- LAYER ') > 0) {
                seq.height = defh;
                const hd = line.replace('(','').replace(')','').split(' ');
                defh = parseFloat(hd[4]);
                if (fdm) dz = -defh / 2;
                newlayer = true;
                autolayer = false;
            }
            line = line.split(";")[0].split(" ").filter(v => v);
            let cmd = line.shift();
            if (!cmd) return;
            if (cmd.charAt(0) === 'T') {
                let ext = scope.settings.device.extruders;
                let pos = parseInt(cmd.charAt(1));
                if (ext && ext[pos]) {
                    xoff.X = -ext[pos].extOffsetX;
                    xoff.Y = -ext[pos].extOffsetY;
                }
            }
            pos.E = 0.0;
            switch (cmd) {
                case 'M82':
                    absE = true;
                    break;
                case 'M83':
                    absE = false;
                    break;
                case 'G20':
                    factor = 25.4;
                    break;
                case 'G21':
                    factor = 1;
                    break;
                case 'G90':
                    // absolute positioning
                    abs = true;
                    break;
                case 'G91':
                    // relative positioning
                    abs = false;
                    break;
                case 'G92':
                    line.forEach(tok => {
                        pos[tok.charAt(0)] = parseFloat(tok.substring(1));
                    });
                    break;
                case 'G10':
                    seq.last().retract = true;
                    break;
                case 'G11':
                    break;
                case 'G0':
                    G0G1(true, line);
                    break;
                case 'G1':
                    G0G1(false, line);
                    break;
                case 'G2':
                    // turn arc into a series of points
                    G2G3(true, line)
                    break;
                case 'G3':
                    // turn arc into a series of points
                    G2G3(false, line);
                    break;
                case 'M6':
                    tool = parseInt(line[0].substring(1));
                    break;
            }
        });

        // recenter for visualization
        // if (false && morph && belt) {
        //     for (let layer of output) {
        //         for (let rec of layer) {
        //             let point = rec.point;
        //             point.y -= bounds.min.z;
        //             point.z += bounds.min.y;
        //         }
        //     }
        // }

        scope.imported = gcode;
        scope.lines = lines.length;
        scope.bytes = gcode.length;
        scope.minSpeed = Math.floor(minf / 60);
        scope.maxSpeed = Math.floor(maxf / 60);
        scope.belt = belt;

        done({ output: scope.output });
    }

}

class Output {
    constructor(point, emit, speed, tool, type) {
        this.point = point; // point to emit
        this.emit = emit; // emit (feed for printers, power for lasers, cut for cam)
        this.speed = speed;
        this.tool = tool;
        this.type = type;
    }

    clone(z) {
        let o = new Output(
            this.point.clone(),
            this.emit,
            this.speed,
            this.tool,
            this.type
        );
        if (z !== undefined) {
            o.point.setZ(z);
        }
        return o;
    }
}

function pref(a,b) {
    return a !== undefined ? a : b;
}

kiri.Print = Print;

})();
