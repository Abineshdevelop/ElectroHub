import express from "express";
import { getCouponsPage } from "../../controllers/user/couponController.js";

const router = express.Router();

router.get("/coupons", getCouponsPage);

export default router;
