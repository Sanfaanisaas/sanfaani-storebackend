import Repair from "../models/Repair.js";
import { catchAsync } from "../utils/catchAsync.js";
import * as repairService from "../services/repairService.js";
import * as quoteService from "../services/quoteService.js";

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

export const createQuote = catchAsync(async (req, res) => {
  const { lineItems } = req.body;
  const quote = await quoteService.createNewQuoteVersion(req.params.id, lineItems, req.user.id);

  res.status(201).json({
    success: true,
    data: quote
  });
});

export const approveQuote = catchAsync(async (req, res) => {
  const quote = await quoteService.approveQuote(req.params.id, req.params.quoteId, req.user.id, req.user.role);

  res.status(200).json({
    success: true,
    data: quote
  });
});

export const startRepair = catchAsync(async (req, res) => {
  const repair = await quoteService.transitionToInRepair(req.params.id);

  res.status(200).json({
    success: true,
    data: repair
  });
});

export const addWorkLog = catchAsync(async (req, res) => {
  const { note } = req.body;
  const repair = await repairService.addWorkLogEntry(req.params.id, req.user.id, note);

  res.status(201).json({
    success: true,
    data: repair
  });
});

export const performQC = catchAsync(async (req, res) => {
  const repair = await repairService.performQC(req.params.id, req.user.id, req.body);

  res.status(200).json({
    success: true,
    data: repair
  });
});
