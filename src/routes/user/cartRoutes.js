import express from "express";
import { getCart, addToCart, updateCart, removeFromCart, clearCart } from "../../controllers/user/cartController.js";
import { isUserLoggedIn } from "../../middlewares/userMiddleware.js";

const router = express.Router();

router.get("/cart",           isUserLoggedIn, getCart);
router.post("/cart/add",      isUserLoggedIn, addToCart);
router.post("/cart/update",   isUserLoggedIn, updateCart);
router.post("/cart/remove",   isUserLoggedIn, removeFromCart);
router.post("/cart/clear",    isUserLoggedIn, clearCart);

export default router;