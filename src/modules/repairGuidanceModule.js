/**
 * Repair and Guidance Lifecycle Module
 * 
 * Deep domain module encapsulating Repair Tracking, Scoped One-Time Credentials,
 * Public Projections, Guidance Sessions, and Advisor Escalations.
 */

import Repair from "../models/Repair.js";
import GuidanceSession from "../models/GuidanceSession.js";
import GuidanceEscalation from "../models/GuidanceEscalation.js";
import AppError from "../utils/AppError.js";

export class RepairGuidanceModule {
  /**
   * Repair Tracking & Public Projections
   */
  async getRepairByTrackingToken(repairId, trackingToken) {
    const repair = await Repair.findById(repairId);
    if (!repair) {
      throw new AppError("Repair order not found", 404);
    }
    
    // Validate tracking token if repair is accessed via token
    if (trackingToken && repair.trackingToken !== trackingToken) {
      throw new AppError("Invalid or expired tracking credential", 401);
    }

    return this.projectPublicRepair(repair);
  }

  /**
   * Filters out internal technician notes and non-customer data
   */
  projectPublicRepair(repair) {
    return {
      id: repair._id || repair.id,
      status: repair.status,
      nextAction: repair.nextAction || "None",
      updatedAt: repair.updatedAt,
      quote: repair.quote ? {
        id: repair.quote.id || repair.quote._id,
        version: repair.quote.version,
        status: repair.quote.status,
        totalAmount: repair.quote.totalAmount,
        lineItems: repair.quote.lineItems,
        expiresAt: repair.quote.expiresAt,
      } : null,
    };
  }

  /**
   * Guidance Sessions & Resume Credentials
   */
  async getGuidanceSession(sessionId, resumeToken) {
    const session = await GuidanceSession.findById(sessionId);
    if (!session) {
      throw new AppError("Guidance session not found", 404);
    }

    if (resumeToken && session.resumeToken !== resumeToken) {
      throw new AppError("Invalid guidance resume token", 401);
    }

    return session;
  }
}

export const repairGuidanceModule = new RepairGuidanceModule();
export default repairGuidanceModule;
