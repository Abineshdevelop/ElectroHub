import express from "express";
import { getCheckoutPage, applyCoupon, removeCoupon, placeOrder, saveAddress, getAvailableCoupons, verifyPayment, handlePaymentFailure, retryPayment, renderPaymentSuccess, renderPaymentFailed } from "../../controllers/user/checkoutController.js";
import { isUserLoggedIn } from "../../middlewares/userMiddleware.js";

const router = express.Router();

router.get("/checkout", isUserLoggedIn, getCheckoutPage);
router.post("/checkout/save-address", isUserLoggedIn, saveAddress);
router.post("/checkout/apply-coupon", isUserLoggedIn, applyCoupon);
router.post("/checkout/remove-coupon", isUserLoggedIn, removeCoupon);
router.post("/checkout/place-order", isUserLoggedIn, placeOrder);
router.get('/checkout/available-coupons', getAvailableCoupons);
router.post("/checkout/verify-payment", isUserLoggedIn, verifyPayment);
router.post("/checkout/payment-failure", isUserLoggedIn, handlePaymentFailure);
router.post("/checkout/retry-payment", isUserLoggedIn, retryPayment);
router.get("/checkout/success", isUserLoggedIn, renderPaymentSuccess);
router.get("/checkout/failed", isUserLoggedIn, renderPaymentFailed);

export default router;