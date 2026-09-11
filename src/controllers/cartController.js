import { catchAsync } from "../utils/catchAsync.js";
import { customerOpsModule } from "../modules/customerOpsModule.js";

export const getCart = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const data = await customerOpsModule.getCart(userId);
  res.status(200).json({ success: true, data });
});

export const addItem = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const data = await customerOpsModule.addItem(userId, req.body);
  res.status(200).json({ success: true, data });
});

export const setItemQuantity = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const data = await customerOpsModule.setItemQuantity(userId, req.params.variantSku, req.body.quantity);
  res.status(200).json({ success: true, data });
});

export const removeItem = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const data = await customerOpsModule.removeItem(userId, req.params.variantSku);
  res.status(200).json({ success: true, data });
});

export const mergeCart = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const data = await customerOpsModule.mergeCart(userId, req.body.guestItems);
  res.status(200).json({ success: true, data });
});

export const formatCartResponse = (cart) => customerOpsModule.formatCartResponse(cart);
