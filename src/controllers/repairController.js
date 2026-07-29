import Repair from "../models/Repair.js";
import { catchAsync } from "../utils/catchAsync.js";
import * as repairService from "../services/repairService.js";

export const createRepair = catchAsync(async (req, res) => {
  const { device, issueDescription, privacyAcknowledged } = req.body;
  
  const repair = await Repair.create({
    customer: req.user._id,
    device,
    issueDescription,
    privacyAcknowledged
  });

  res.status(201).json({
    success: true,
    data: repair
  });
});

export const intakeRepair = catchAsync(async (req, res) => {
  const repair = await repairService.intakeRepair(req.params.id, req.body);
  
  res.status(200).json({
    success: true,
    data: repair
  });
});

export const assignTechnician = catchAsync(async (req, res) => {
  const { technicianId } = req.body;
  const repair = await repairService.assignTechnician(req.params.id, technicianId);

  res.status(200).json({
    success: true,
    data: repair
  });
});

export const recordDiagnosis = catchAsync(async (req, res) => {
  const repair = await repairService.recordDiagnosis(req.params.id, req.user.id, req.body);

  res.status(200).json({
    success: true,
    data: repair
  });
});
