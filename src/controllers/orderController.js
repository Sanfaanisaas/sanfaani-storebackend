import Order from "../models/Order.js";
import { catchAsync } from "../utils/catchAsync.js";

/**
 * Get authenticated user's orders with pagination
 */
export const getMyOrders = catchAsync(async (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;
  const skip = (page - 1) * limit;

  const query = { user: req.user.id };

  const [orders, totalCount] = await Promise.all([
    Order.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Order.countDocuments(query),
  ]);

  const publicOrders = orders.map((order) => order.toPublicOrder());

  res.status(200).json({
    success: true,
    data: {
      orders: publicOrders,
      totalCount,
      page,
      totalPages: Math.ceil(totalCount / limit),
    },
  });
});
