import express from "express";
import {
  getWishlist,
  addToWishlist,
  removeFromWishlist,
} from "../../controllers/user/wishlistController.js";
import { isUserLoggedIn } from "../../middlewares/userMiddleware.js";

const router = express.Router();

router.get("/wishlist",        isUserLoggedIn, getWishlist);
router.post("/wishlist/add",   isUserLoggedIn, addToWishlist);
router.post("/wishlist/remove",isUserLoggedIn, removeFromWishlist);

export default router;