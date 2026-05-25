import express from "express";
import {
  getOrderHistory,
  getOrderDetails,
  cancelOrder,
  requestReturn,
} from "../../controllers/user/orderController.js";
import { downloadInvoice } from "../../controllers/user/invoiceController.js";
import { isUserLoggedIn } from "../../middlewares/userMiddleware.js";

const router = express.Router();

router.get("/orders",                  isUserLoggedIn, getOrderHistory);
router.get("/orders/:orderId",          isUserLoggedIn, getOrderDetails);
router.post("/orders/:orderId/cancel",  isUserLoggedIn, cancelOrder);
router.post("/orders/:orderId/return",  isUserLoggedIn, requestReturn);
router.get("/orders/:orderId/invoice", isUserLoggedIn, downloadInvoice);
router.get("/orders/:orderId/items/:itemId/invoice", isUserLoggedIn, downloadInvoice);

export default router;
