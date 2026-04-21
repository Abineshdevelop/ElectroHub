import express from "express";
import {
  getWalletPage,
  createTopupOrder,
  verifyTopup,
} from "../../controllers/user/walletController.js";
import { isUserLoggedIn } from "../../middlewares/userMiddleware.js";

const router = express.Router();

router.get("/wallet",                isUserLoggedIn, getWalletPage);
router.post("/wallet/create-topup",  isUserLoggedIn, createTopupOrder);
router.post("/wallet/verify-topup",  isUserLoggedIn, verifyTopup);

export default router;
