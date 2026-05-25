import express from "express"
import {getProductListingPage, getMaxPrice, toggleWishlist} from "../../controllers/user/listController.js"
import { isUserLoggedIn } from "../../middlewares/userMiddleware.js"

const router = express.Router()

router.get("/list/max-price", getMaxPrice)
router.get("/list", getProductListingPage)
router.post('/wishlist/toggle', isUserLoggedIn, toggleWishlist);

export default router;