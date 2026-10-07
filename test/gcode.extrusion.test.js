import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { fileURLToPath } from "url";
import AdmZip from "adm-zip";

import {
    parseSliceInfo,
    calcFullConsumption,
    calcPartialConsumption,
    completedLayerIndex,
    createExtrusionCounter,
    checkLayerExtrusion,
    countPlateExtrusion,
} from "../src/gcode.js";

// Two sliced files read off a P2S on 2026-10-07, both printed there on
// 2026-09-08 and sliced by Bambu Studio 02.08.02.61:
//
//   p2s_cube.gcode.3mf         a 20 mm cube, one filament (id 4, PLA Basic
//                              black, 1.94 g), 11 layers, 0.6 mm nozzle. The
//                              cancel at layer_num 9 that settled
//                              completedLayerIndex() was this plate.
//   p2s_two_colours.gcode.3mf  a sign, white (id 1, 5.87 g) over layers 0 to
//                              4 and black (id 2, 0.68 g) over 5 to 7, one
//                              filament change.
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

/** The slice info of a fixture with the G-code counted, as fetchSliceInfo() builds it. */
async function load(name) {
    const zip = new AdmZip(path.join(fixtures, name));
    const sliceInfo = parseSliceInfo(
        zip.getEntry("Metadata/slice_info.config").getData().toString("utf8"),
        zip.getEntry("Metadata/project_settings.config")?.getData().toString("utf8") ?? null,
    );
    const perLayer = await countPlateExtrusion(zip.getEntry("Metadata/plate_1.gcode"));
    sliceInfo.extrusion = checkLayerExtrusion(perLayer, sliceInfo.filaments);
    return { sliceInfo, perLayer };
}

/** Grams per filament id. */
function byId(consumption) {
    return Object.fromEntries(Object.values(consumption).map(e => [e.index + 1, e.grams]));
}

test("cube: the G-code is counted per layer under the filament's index", async () => {
    const { sliceInfo, perLayer } = await load("p2s_cube.gcode.3mf");
    assert.deepEqual(Object.keys(perLayer), ["3"]);
    // Start G-code plus the 11 layers of M73 L1 to L11
    assert.equal(perLayer[3].length, 12);
    const metres = perLayer[3].reduce((a, b) => a + b, 0) / 1000;
    assert.ok(Math.abs(metres - 0.64) < 0.01, `counted ${metres} m`);
    assert.deepEqual(sliceInfo.extrusion.rejected, []);
});

test("cube: a cancel books the layers it printed, not an even share of them", async () => {
    const { sliceInfo } = await load("p2s_cube.gcode.3mf");
    const even = { ...sliceInfo, extrusion: null };
    const upTo = completedLayerIndex(9);
    // The layers of sparse infill in the middle weigh a third of a solid one,
    // so eight layers out of eleven are much less than 8/11 of the cube
    assert.equal(byId(calcPartialConsumption(even, upTo))[4], 1.41);
    assert.equal(byId(calcPartialConsumption(sliceInfo, upTo))[4], 1.12);
});

test("cube: the last layer books exactly what a finished print books", async () => {
    const { sliceInfo } = await load("p2s_cube.gcode.3mf");
    assert.equal(byId(calcFullConsumption(sliceInfo))[4], 1.94);
    assert.equal(byId(calcPartialConsumption(sliceInfo, sliceInfo.totalLayers))[4], 1.94);
});

test("cube: nothing is booked before the first layer has extruded anything", async () => {
    const { sliceInfo } = await load("p2s_cube.gcode.3mf");
    assert.equal(byId(calcPartialConsumption(sliceInfo, completedLayerIndex(0)))[4], 0);
    assert.equal(byId(calcPartialConsumption(sliceInfo, completedLayerIndex(1)))[4], 0);
});

test("two colours: the second filament starts on the layer of the change", async () => {
    const { sliceInfo, perLayer } = await load("p2s_two_colours.gcode.3mf");
    assert.deepEqual(perLayer[1].slice(0, 6), [0, 0, 0, 0, 0, 0]);
    assert.ok(perLayer[1][6] > 0);
    assert.deepEqual(sliceInfo.extrusion.rejected, []);

    // M73 L5 complete: black has not started, and white is all done but
    // the 5 mm it extrudes on layer 6 before the change
    const before = byId(calcPartialConsumption(sliceInfo, 4));
    assert.equal(before[1], 5.85);
    assert.equal(before[2], 0);

    const after = byId(calcPartialConsumption(sliceInfo, 5));
    assert.ok(after[2] > 0 && after[2] < 0.68);
});

test("a G-code total far from the slicer's is not trusted for that filament", () => {
    const filaments = [
        { id: 1, index: 0, used_m: 2 },
        { id: 2, index: 1, used_m: 2 },
    ];
    const perLayer = { 0: [0, 1000, 1000], 1: [0, 500, 500] };
    const checked = checkLayerExtrusion(perLayer, filaments);
    assert.deepEqual(checked.shares[0], [0, 0.5, 1]);
    assert.equal(checked.shares[1], undefined);
    assert.deepEqual(checked.rejected, [{ id: 2, gcodeMetres: 1, slicedMetres: 2 }]);
});

test("a filament the G-code never extrudes is not trusted either", () => {
    const checked = checkLayerExtrusion({}, [{ id: 3, index: 2, used_m: 0.5 }]);
    assert.deepEqual(checked.shares, {});
    assert.deepEqual(checked.rejected, [{ id: 3, gcodeMetres: 0, slicedMetres: 0.5 }]);
});

test("the counter follows tool changes, layers and both extrusion modes", () => {
    const counter = createExtrusionCounter();
    const lines = [
        "G1 E2 ; before any T, belongs to the first filament",
        "  T2",
        "M83",
        "G1 X1 E1.5",
        "G1 X2 E-.5 ; retraction",
        "M73 P10 R3",
        "M73 L1",
        "G1 X3 E3",
        "G2 X4 I1 J1 E1",
        "T255",
        "G1 E4 ; unload selects nothing, still filament 2",
        "M73 L2",
        "T0",
        "M82",
        "G92 E10",
        "G1 E12",
        "G1 E15",
        "; G1 E100 only a comment",
        "M620.10 A1 L78 ; firmware flush, not extrusion",
    ];
    for (const line of lines) counter.line(line);
    assert.deepEqual(counter.result(), {
        0: [0, 0, 5],
        2: [3, 8],
    });
});
