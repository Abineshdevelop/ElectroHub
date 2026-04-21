import express from "express";
import {
  getOrderHistory,
  getOrderDetails,
  cancelOrder,
  requestReturn,
  downloadInvoice,
} from "../../controllers/user/orderController.js";
import { isUserLoggedIn } from "../../middlewares/userMiddleware.js";

const router = express.Router();

router.get("/orders",                  isUserLoggedIn, getOrderHistory);
router.get("/orders/:orderId",          isUserLoggedIn, getOrderDetails);
router.post("/orders/:orderId/cancel",  isUserLoggedIn, cancelOrder);
router.post("/orders/:orderId/return",  isUserLoggedIn, requestReturn);
router.get("/orders/:orderId/invoice", isUserLoggedIn, downloadInvoice);

export default router;