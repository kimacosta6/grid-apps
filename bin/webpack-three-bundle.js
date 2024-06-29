import * as THREE from "../node_modules/three/build/three.module.js";
import * as SVGLoader from "../node_modules/three/examples/jsm/loaders/SVGLoader.js";
import * as BGU from "../node_modules/three/examples/jsm/utils/BufferGeometryUtils.js";

console.log('THIS IS MY THREE BUNDLE');

self.THREE = THREE;
self.SVGLoader = SVGLoader;
self.BGU = BGU;
