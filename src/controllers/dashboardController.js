import * as dashboardService from "../services/dashboardService.js";
import { catchAsync } from "../utils/catchAsync.js";

export const getDashboardQueue = catchAsync(async (req, res) => {
  const data = await dashboardService.getQueueForRole(req.user);

  res.status(200).json({
    success: true,
    data
  });
});
