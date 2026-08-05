import { Router } from 'express';
import * as userController from "../../controllers/user/auth.controller.js";
import profileController from "../../controllers/user/profile.controller.js";
import { isUserLoggedIn, isLoggedOut } from "../../middlewares/userMiddleware.js";
import upload from "../../middlewares/uploads.js";
import { uploadToCloudinaryMiddleware } from "../../middlewares/cloudinaryUpload.js";
import addressController from "../../controllers/user/address.controller.js"
import passport from "passport";
import { getSearchSuggestions, getNavCategories, getNavCategoryProducts, getNavCounts } from "../../controllers/user/searchController.js";
import { loadHomePage } from "../../controllers/user/homeController.js";

const router = Router();

router.get('/signup', isLoggedOut, userController.loadSignup)
router.post('/signup', userController.signupUser)
router.post('/validate-referral', userController.validateReferralCode)
router.get('/signup-otp', userController.loadSignupOtp)
router.post('/resend-otp', userController.resendOtp); 
router.post('/verify-otp', userController.verifyOtp);
router.post("/resend-forgot-otp", userController.resendForgotOtp);
router.get('/login', isLoggedOut, userController.loadLogin);
router.post("/login", isLoggedOut, userController.loginUser);
router.get("/logout", userController.logoutUser);
router.get("/home", loadHomePage)
router.get("/auth/google",passport.authenticate("google", { scope: ["profile", "email"] }));

router.get("/auth/google/callback",
  (req, res, next) => {
    passport.authenticate("google", (err, user, info) => {
      if (err) return next(err);

      //blocked or failed
      if (!user) {
        const message = info?.message || "Google login failed";
        req.logout(() => {
          req.session.flashError = message; //store in session
          req.session.save(() => {
            res.redirect("/user/login");
          });
        });
        return;
      }

      req.logIn(user, { keepSessionInfo: true }, (err) => {
        if (err) return next(err);

        req.session.user = {
          _id: user._id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          status: user.status,
          authType: user.authType
        };

        res.redirect("/user/home");
      });
    })(req, res, next);
  }
);

router.get("/forgot-password", isLoggedOut, userController.loadForgotPassword);
router.post("/forgot-password", isLoggedOut, userController.forgotPassword);

router.get("/forgot-password-otp", isLoggedOut, userController.loadForgotPasswordOtp);
router.post("/verify-forgot-otp", userController.verifyForgotOtp);

router.get("/reset-password", isLoggedOut, userController.loadResetPassword);
router.post("/reset-password", isLoggedOut, userController.resetPassword);


router.get("/dashboard", isUserLoggedIn, profileController.loadDashboard);

router.get("/address", isUserLoggedIn, addressController.loadAddress);
router.patch("/address/remove-default/:id", isUserLoggedIn, addressController.removeDefaultAddress);
router.patch("/address/default/:id", isUserLoggedIn, addressController.setDefaultAddress);
router.delete("/address/delete/:id", isUserLoggedIn, addressController.deleteAddress);
router.patch("/address/:id", isUserLoggedIn, addressController.updateAddress);
router.post("/address/add", isUserLoggedIn, addressController.addAddress);

router.get("/profile", isUserLoggedIn, profileController.loadProfile);

router.get('/search-suggestions',      getSearchSuggestions);
router.get('/nav-categories',          getNavCategories);
router.get('/nav-category-products', getNavCategoryProducts);
router.get('/nav-counts', getNavCounts);


router.post(
  "/profile/avatar",
  isUserLoggedIn,
  upload.single("avatar"),
  uploadToCloudinaryMiddleware('profiles'),
  profileController.updateAvatar
);

router.post(
  "/profile/avatar/remove",
  isUserLoggedIn,
  profileController.removeAvatar
);

router.post("/profile/email/request-otp", isUserLoggedIn, profileController.requestEmailChangeOtp);
router.post("/profile/email/verify-otp", isUserLoggedIn, profileController.verifyEmailChangeOtp);
router.post("/profile/update", isUserLoggedIn, profileController.updateProfileDetails);

router.post("/profile/password/request-otp", isUserLoggedIn, profileController.requestPasswordChangeOtp);
router.post("/profile/password/verify-otp", isUserLoggedIn, profileController.verifyPasswordChangeOtp);
router.post('/profile/avatar/ajax', upload.single('avatar'), uploadToCloudinaryMiddleware('profiles'), isUserLoggedIn, profileController.updateAvatarAjax);
router.post('/profile/avatar/remove/ajax', isUserLoggedIn, profileController.removeAvatarAjax);

export default router
