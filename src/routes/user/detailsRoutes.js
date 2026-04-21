import express from "express";
import { getProductDetailPage, getRelatedProducts } from "../../controllers/user/productDetailsController.js";
import { isUserLoggedIn } from "../../middlewares/userMiddleware.js";

const router = express.Router();

router.get("/product/:id/related", getRelatedProducts);
router.get("/product/:id", getProductDetailPage);

export default router;