import assert from "node:assert/strict";
import test from "node:test";

import { reasoningSummaryFor } from "../src/copilot/reasoningOptions.js";

test("uses detailed summaries unless reasoning is disabled", () => {
    assert.equal(reasoningSummaryFor(undefined), "detailed");
    assert.equal(reasoningSummaryFor("none"), "none");
    for (const effort of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
        assert.equal(reasoningSummaryFor(effort), "detailed");
    }
});
