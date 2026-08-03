// web/src/setup/rerun.ts：Re-run wizard 的共享常量。BootstrapGate 读它、Settings System 区
// （Task 25）写它——字面量不许双写：一处漂移，"重进向导"就成死链，而且是静默的死链。
export const RERUN_WIZARD_KEY = 'scout-rerun-wizard'
