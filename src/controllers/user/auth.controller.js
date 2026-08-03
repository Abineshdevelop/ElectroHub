import User from "../../model/usermodel.js";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import sendMail from "../../services/mailService.js";
import { AppError } from "../../errors/appError.js";
import { creditWallet } from "./walletController.js";

// Constants for OTP security rules
const MAX_RESENDS = 3;
const MAX_ATTEMPTS = 5;

/**
 * Helper function to generate a unique random uppercase referral code.
 * Example output: "A1B2C3D4"
 */
export async function generateReferralToken() {
  let token = crypto.randomBytes(4).toString("hex").toUpperCase();
  let existingUser = await User.findOne({ referralToken: token });

  // Keep generating a new token until a unique one is found
  while (existingUser) {
    token = crypto.randomBytes(4).toString("hex").toUpperCase();
    existingUser = await User.findOne({ referralToken: token });
  }

  return token;
}

/**
 * Helper function to generate a 4-digit OTP, save it to the user, and send an email.
 */
export async function generateAndSendOtp(user) {
  // Step 1: Generate a random 4-digit OTP
  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  console.log(`[OTP Sent] Email: ${user.email} -> OTP: ${otp}`);

  // Step 2: Attach OTP details and set 2-minute expiration
  user.otp = otp;
  user.otpExpiresAt = new Date(Date.now() + 2 * 60 * 1000);
  user.otpAttempts = 0;
  user.otpLockedUntil = null;

  await user.save();

  // Step 3: Send OTP email to the user
  await sendMail(
    user.email,
    "Your OTP for ElectroHub",
    `<h2>Your OTP is ${otp}</h2><p>Valid for 2 minutes</p>`
  );
}

/**
 * Step-by-step User Signup Handler
 */
export async function signupUser(req, res, next) {
  try {
    const { firstName, lastName, email, phone, password, referralCode } = req.body;

    // Step 1: Validate required input fields
    if (!firstName || !lastName || !email || !phone || !password) {
      throw new AppError(400, "All fields are required");
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanPhone = phone.trim();

    // Step 2: Validate email, phone, and password formats
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const phoneRegex = /^\d{10}$/;
    const strongPasswordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&]).{8,}$/;

    if (!emailRegex.test(cleanEmail)) {
      throw new AppError(400, "Enter a valid email address");
    }

    if (!phoneRegex.test(cleanPhone)) {
      throw new AppError(400, "Enter a valid 10-digit phone number");
    }

    if (!strongPasswordRegex.test(password)) {
      throw new AppError(400, "Password must contain 8+ characters, uppercase, lowercase, number and special character");
    }

    // Step 3: Validate optional referral code
    let referredBy = null;
    if (referralCode && referralCode.trim()) {
      const trimmedCode = referralCode.trim().toUpperCase();
      const referrer = await User.findOne({ referralToken: trimmedCode });

      if (!referrer) {
        throw new AppError(400, "Invalid referral code");
      }

      if (referrer.email === cleanEmail || referrer.phone === cleanPhone) {
        throw new AppError(400, "You cannot refer yourself");
      }

      referredBy = referrer._id;
    }

    // Step 4: Check if an active account already uses this email or phone
    const existingEmailUser = await User.findOne({ email: cleanEmail });
    if (existingEmailUser && existingEmailUser.status !== "pending") {
      throw new AppError(400, "Email Already exist");
    }

    const existingPhoneUser = await User.findOne({ phone: cleanPhone });
    if (existingPhoneUser && existingPhoneUser.status !== "pending") {
      throw new AppError(400, "Phone Number Already exist");
    }

    // Step 5: Remove old pending accounts with matching email or phone
    if (existingEmailUser && existingEmailUser.status === "pending") {
      await User.deleteOne({ email: cleanEmail });
    }
    if (existingPhoneUser && existingPhoneUser.status === "pending") {
      await User.deleteOne({ phone: cleanPhone });
    }

    // Step 6: Hash the password and create the pending user record
    const passwordHash = await bcrypt.hash(password, 10);

    const newUser = await User.create({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: cleanEmail,
      phone: cleanPhone,
      password: passwordHash,
      status: "pending",
      authType: "local",
      referredBy: referredBy
    });

    // Step 7: Generate OTP and authorize OTP page access in session
    await generateAndSendOtp(newUser);
    req.session.allowSignupOtp = newUser._id.toString();

    // Step 8: Return success response
    res.status(201).json({
      success: true,
      message: "OTP sent",
      userId: newUser._id
    });

  } catch (err) {
    next(err);
  }
}

/**
 * Step-by-step OTP Verification for Signup
 */
export async function verifyOtp(req, res, next) {
  try {
    const { userId, otp } = req.body;

    // Step 1: Find user by ID
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Step 2: Check if OTP attempts are currently locked
    const now = new Date();
    if (user.otpLockedUntil && user.otpLockedUntil > now) {
      return res.status(429).json({
        success: false,
        code: "LOCKED",
        message: "Too many attempts. Please wait until OTP expires."
      });
    }

    // Step 3: Check if OTP is missing or expired
    if (!user.otp || !user.otpExpiresAt || user.otpExpiresAt < now) {
      if (user.otpResendCount >= MAX_RESENDS) {
        await User.deleteOne({ _id: user._id });
        return res.status(403).json({
          success: false,
          code: "RESTART_SIGNUP",
          message: "OTP expired after maximum resends. Please sign up again."
        });
      }

      return res.status(400).json({
        success: false,
        code: "OTP_EXPIRED",
        message: "OTP expired. Please resend OTP."
      });
    }

    // Step 4: Handle wrong OTP code
    if (user.otp !== otp) {
      user.otpAttempts += 1;
      const attemptsLeft = Math.max(0, MAX_ATTEMPTS - user.otpAttempts);

      if (user.otpAttempts >= MAX_ATTEMPTS) {
        user.otpLockedUntil = user.otpExpiresAt;
        await user.save();

        if (user.otpResendCount >= MAX_RESENDS) {
          await User.deleteOne({ _id: user._id });
          return res.status(403).json({
            success: false,
            code: "RESTART_SIGNUP",
            message: "Too many failed attempts. Please sign up again."
          });
        }

        return res.status(400).json({
          success: false,
          code: "LOCKED",
          attemptsLeft: 0
        });
      }

      await user.save();
      return res.status(400).json({
        success: false,
        code: "WRONG_OTP",
        attemptsLeft: attemptsLeft
      });
    }

    // Step 5: OTP is Correct! Activate user account
    user.status = "active";
    user.otp = null;
    user.otpExpiresAt = null;
    user.otpAttempts = 0;
    user.otpLockedUntil = null;
    user.otpResendCount = 0;

    user.referralToken = await generateReferralToken();

    // Reward both users if signed up via referral link
    if (user.referredBy) {
      await creditWallet(user._id, 1000, "Signup referral bonus", "referral_bonus");
      await creditWallet(user.referredBy, 1000, "Friend referral reward", "referral_reward");
    }

    await user.save();

    // Step 6: Create user session and return redirect URL
    req.session.user = {
      _id: user._id,
      email: user.email,
      firstName: user.firstName
    };

    return res.json({ success: true, redirect: "/user/home" });

  } catch (err) {
    next(err);
  }
}

/**
 * Resend OTP for Signup
 */
export async function resendOtp(req, res) {
  try {
    const { userId } = req.body;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ success: false });
    }

    // Prevent resending if max resend count is reached
    if (user.otpResendCount >= MAX_RESENDS) {
      return res.json({
        success: false,
        code: "FLOW_ENDED"
      });
    }

    // Prevent resending before current OTP expires
    const now = new Date();
    if (user.otpExpiresAt && user.otpExpiresAt > now) {
      const secondsLeft = Math.ceil((user.otpExpiresAt - now) / 1000);
      return res.status(429).json({
        success: false,
        message: `Please wait ${secondsLeft} seconds`
      });
    }

    user.otpResendCount += 1;
    user.otpAttempts = 0;

    await generateAndSendOtp(user);

    return res.json({
      success: true,
      otpExpiresAt: user.otpExpiresAt.getTime()
    });

  } catch (err) {
    return res.status(500).json({ success: false });
  }
}

/**
 * Step-by-step User Login Handler
 */
export async function loginUser(req, res, next) {
  try {
    const { identifier, password } = req.body;

    // Step 1: Check required fields
    if (!identifier || !password) {
      throw new AppError(400, "All fields are required");
    }

    // Step 2: Find user by email or phone number
    const user = await User.findOne({
      $or: [{ email: identifier }, { phone: identifier }]
    });

    if (!user) {
      return res.json({
        success: false,
        message: "Account not found. Please sign up."
      });
    }

    // Step 3: Check if account is blocked by admin
    if (user.status === "blocked") {
      return res.json({
        success: false,
        blocked: true,
        message: "Your account has been blocked by the admin. Please contact support for assistance."
      });
    }

    // Step 4: Check if account was created with Google login
    if (user.authType === "google") {
      return res.json({
        success: false,
        googleAccount: true,
        message: "This email is registered with Google. Please sign in using Google."
      });
    }

    // Step 5: Compare password with hashed password in database
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.json({
        success: false,
        message: "Invalid password"
      });
    }

    // Step 6: Create user session
    req.session.user = {
      _id: user._id,
      email: user.email,
      phone: user.phone,
      firstName: user.firstName,
      lastName: user.lastName,
      isAdmin: user.isAdmin,
      status: user.status
    };

    req.session.save((err) => {
      if (err) console.error("Session save error during user login:", err);
      return res.json({ success: true });
    });

  } catch (err) {
    next(err);
  }
}

/**
 * Auth Page Loaders
 */

export async function loadSignup(req, res) {
  if (req.session.user) {
    return res.redirect("/");
  }
  res.render("user/auth/signup");
}

export async function loadSignupOtp(req, res) {
  if (req.session.user) return res.redirect("/");

  const userId = req.query.userId;

  if (!userId || req.session.allowSignupOtp !== userId) {
    return res.redirect("/user/signup");
  }

  const user = await User.findById(userId);

  if (!user || user.status !== "pending" || !user.otp || !user.otpExpiresAt) {
    return res.redirect("/user/signup");
  }

  req.session.allowSignupOtp = null;

  return res.render("user/auth/signup-otp", {
    otpExpiresAt: user.otpExpiresAt.getTime(),
    userId: user._id
  });
}

export async function loadForgotPasswordOtp(req, res) {
  const userId = req.query.userId;

  if (!userId || req.session.allowForgotOtp !== userId) {
    return res.redirect("/user/forgot-password");
  }

  const user = await User.findById(userId);

  if (!user || !user.otp || !user.otpExpiresAt) {
    return res.redirect("/user/forgot-password");
  }

  req.session.allowForgotOtp = null;

  res.render("user/auth/forgot-password-otp", {
    otpExpiresAt: user.otpExpiresAt.getTime(),
    userId: user._id
  });
}

export async function loadLogin(req, res) {
  if (req.session.user) {
    return res.redirect("/");
  }

  const flashError = req.session.flashError || null;
  req.session.flashError = null;

  const blocked = req.query.blocked === "true";
  res.render("user/auth/login", { flashError, blocked });
}

export async function logoutUser(req, res) {
  req.logout({ keepSessionInfo: true }, (err) => {
    if (err) console.error("Passport logout error:", err);
    delete req.session.user;
    req.session.save((err) => {
      if (err) console.error("Session save error during user logout:", err);
      res.redirect("/user/login");
    });
  });
}

export async function loadForgotPassword(req, res) {
  res.render("user/auth/forgot-password");
}

/**
 * Handle Forgot Password Request
 */
export async function forgotPassword(req, res) {
  try {
    const { email } = req.body;

    // Step 1: Validate email
    if (!email || !email.trim()) {
      return res.json({ success: false, message: "Email is required" });
    }

    const cleanEmail = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(cleanEmail)) {
      return res.json({ success: false, message: "Enter a valid email address" });
    }

    // Step 2: Find user by email
    const user = await User.findOne({ email: cleanEmail });
    if (!user) {
      return res.json({ success: false, message: "No account found with this email" });
    }

    // Step 3: Check if Google login account
    if (user.authType === "google") {
      return res.json({
        success: false,
        googleAccount: true,
        message: "This account was created using Google. Please sign in with Google."
      });
    }

    // Step 4: Reset OTP metrics and send OTP email
    user.otpResendCount = 0;
    user.otpAttempts = 0;
    user.otpLockedUntil = null;

    await generateAndSendOtp(user);

    req.session.allowForgotOtp = user._id.toString();

    return res.json({ success: true, userId: user._id });

  } catch (err) {
    console.error("Forgot password error:", err);
    return res.json({ success: false, message: "Something went wrong" });
  }
}

/**
 * Verify OTP for Forgot Password
 */
export async function verifyForgotOtp(req, res) {
  try {
    const { userId, otp } = req.body;

    // Step 1: Find user by ID
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false });
    }

    // Step 2: Check if OTP is expired
    const now = new Date();
    if (!user.otpExpiresAt || user.otpExpiresAt < now) {
      return res.json({ success: false, code: "OTP_EXPIRED" });
    }

    // Step 3: Check if OTP is wrong
    if (user.otp !== otp) {
      user.otpAttempts += 1;
      await user.save();

      if (user.otpAttempts >= MAX_ATTEMPTS) {
        if (user.otpResendCount >= MAX_RESENDS) {
          return res.json({ success: false, code: "FLOW_ENDED" });
        }
        return res.json({ success: false, code: "MAX_ATTEMPTS" });
      }

      return res.json({
        success: false,
        code: "WRONG_OTP",
        attemptsLeft: MAX_ATTEMPTS - user.otpAttempts
      });
    }

    // Step 4: OTP Verified! Clear OTP details and set password reset permission
    user.otp = null;
    user.otpExpiresAt = null;
    user.otpAttempts = 0;
    user.otpResendCount = 0;
    await user.save();

    req.session.allowReset = user._id.toString();

    return res.json({
      success: true,
      redirect: `/user/reset-password?userId=${user._id}`
    });

  } catch (err) {
    return res.status(500).json({ success: false });
  }
}

/**
 * Resend OTP for Forgot Password
 */
export async function resendForgotOtp(req, res) {
  try {
    const { userId } = req.body;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Prevent resend before expiry
    const now = new Date();
    if (user.otpExpiresAt && user.otpExpiresAt > now) {
      const secondsLeft = Math.ceil((user.otpExpiresAt - now) / 1000);
      return res.status(429).json({
        success: false,
        message: `Please wait ${secondsLeft} seconds`
      });
    }

    if (user.otpResendCount >= MAX_RESENDS) {
      return res.status(403).json({
        success: false,
        code: "FLOW_ENDED",
        message: "Resend limit reached. Please restart forgot password."
      });
    }

    user.otpResendCount += 1;
    user.otpAttempts = 0;

    await generateAndSendOtp(user);

    return res.json({
      success: true,
      otpExpiresAt: user.otpExpiresAt.getTime()
    });

  } catch (err) {
    console.error("Resend forgot OTP error:", err);
    return res.status(500).json({ success: false, message: "Resend failed" });
  }
}

/**
 * Load Reset Password Page
 */
export async function loadResetPassword(req, res) {
  try {
    const userId = req.query.userId;

    if (!userId || req.session.allowReset !== userId) {
      return res.redirect("/user/forgot-password");
    }

    const user = await User.findById(userId);

    if (!user || user.otp !== null) {
      return res.redirect("/user/forgot-password");
    }

    req.session.allowReset = null;

    res.render("user/auth/reset-password", { userId: user._id });

  } catch {
    return res.redirect("/user/forgot-password");
  }
}

/**
 * Step-by-step Reset Password Handler
 */
export async function resetPassword(req, res) {
  try {
    const { userId, password, confirmPassword } = req.body;

    // Step 1: Validate input presence
    if (!userId) {
      return res.status(400).json({ success: false, message: "Invalid request" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (user.authType === "google") {
      return res.json({
        success: false,
        googleAccount: true,
        message: "This account was created using Google. Please sign in with Google."
      });
    }

    // Step 2: Validate password strength and matching confirmation
    const strongPasswordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&]).{8,}$/;

    if (!strongPasswordRegex.test(password)) {
      return res.status(400).json({
        success: false,
        message: "Password must contain 8+ characters, uppercase, lowercase, number and special character"
      });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ success: false, message: "Passwords do not match" });
    }

    // Step 3: Hash new password & save to user account
    const hashedPassword = await bcrypt.hash(password, 10);
    user.password = hashedPassword;
    user.otp = null;
    user.otpExpiresAt = null;
    await user.save();

    // Step 4: Return success response
    return res.json({
      success: true,
      message: "Password reset successful",
      redirect: "/user/login"
    });

  } catch (err) {
    console.error("Reset password error:", err);
    return res.status(500).json({ success: false, message: "Reset failed" });
  }
}

/**
 * Validate Referral Code via Ajax
 */
export async function validateReferralCode(req, res) {
  try {
    const { code } = req.body;
    if (!code) return res.json({ success: false, message: "No code provided" });

    const referrer = await User.findOne({
      referralToken: code.trim().toUpperCase()
    });

    if (referrer) {
      return res.json({ success: true, message: "Valid referral code!" });
    } else {
      return res.json({ success: false, message: "Invalid referral code" });
    }
  } catch (err) {
    return res.json({ success: false, message: "Error validating code" });
  }
}