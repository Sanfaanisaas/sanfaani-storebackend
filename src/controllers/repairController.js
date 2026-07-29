import Repair from "../models/Repair.js";
import { catchAsync } from "../utils/catchAsync.js";

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
