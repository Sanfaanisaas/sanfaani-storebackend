/**
 * Canonical Backend Domain Application Modules Entry Point
 */

import customerOpsModule from "./customerOpsModule.js";
import repairGuidanceModule from "./repairGuidanceModule.js";

export { customerOpsModule, repairGuidanceModule };

export default {
  customerOps: customerOpsModule,
  repairGuidance: repairGuidanceModule,
};
