///login, signup, logout, otp, forgot password

import User from "../../model/usermodel.js"
import bcrypt from "bcryptjs";
import sendMail from "../../services/mailService.js";
import { AppError } from "../../errors/appError.js";

const MAX_RESENDS = 3;
const MAX_ATTEMPTS = 5;

export async function generateAndSendOtp(user) {
  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  console.log(`Email send OTP is :  ${otp}`)
  user.otp = otp;
  user.otpExpiresAt = new Date(Date.now() + 2 * 60 * 1000);
  user.otpAttempts = 0;
  user.otpLockedUntil = null;

  await user.save();

  await sendMail(
    user.email,
    "Your OTP for ElectroHub",
    `<h2>Your OTP is ${otp}</h2><p>Valid for 2 minutes</p>`
  );
}

export async function signupUser(req, res, next) {
  try {
    const { firstName, lastName, email, phone, password } = req.body;

    if (!firstName || !lastName || !email || !phone || !password) {
      throw new AppError(400, "All fields are required");
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanPhone = phone.trim();

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

    const [existingUserWithEmail, existingUserWithPhone] = await Promise.all([
      User.findOne({ email: cleanEmail }),
      User.findOne({ phone: cleanPhone })
    ]);

    if (existingUserWithEmail && existingUserWithPhone) {
      if (existingUserWithEmail?.status == "active" && existingUserWithPhone?.status == "active") {
        throw new AppError(400, "User Already Exist");
      }
    }

    if (existingUserWithPhone && existingUserWithPhone?.status != "pending") {
      throw new AppError(400, "Phone Number Already exist");
    }

    if (existingUserWithEmail && existingUserWithEmail?.status != "pending") {
      throw new AppError(400, "Email Already exist");
    }

    if (existingUserWithEmail?.status == "pending") {
      await User.deleteOne({ email: cleanEmail });
    }

    if (!existingUserWithEmail && existingUserWithPhone?.status == "pending") {
      await User.deleteOne({ phone: cleanPhone });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await User.create({
      firstName,
      lastName,
      email: cleanEmail,
      phone: cleanPhone,
      password: passwordHash,
      status: "pending",
      authType: "local"
    });

    await generateAndSendOtp(user);
    req.session.allowSignupOtp = user._id.toString();

    res.status(201).json({
      success: true,
      message: "OTP sent",
      userId: user._id
    });

  } catch (err) {
    next(err);
  }
}

export async function verifyOtp(req, res, next) {
  try {
    const { userId, otp } = req.body;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Locked until expiry
    if (user.otpLockedUntil && user.otpLockedUntil > new Date()) {
      return res.status(429).json({
        success: false,
        code: "LOCKED",
        message: "Too many attempts. Please wait until OTP expires."
      });
    }

    // OTP expired
    if (!user.otp || user.otpExpiresAt < new Date()) {
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

    // Wrong OTP
    // Wrong OTP
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
          code: "LOCKED",          // ✅ send LOCKED not WRONG_OTP when 0 left
          attemptsLeft: 0
        });
      }
    
      await user.save();
    
      return res.status(400).json({
        success: false,
        code: "WRONG_OTP",
        attemptsLeft                // ✅ this will be 3,2,1 — never 0
      });
    }

    // SUCCESS
    user.status = "active";
    user.otp = null;
    user.otpExpiresAt = null;
    user.otpAttempts = 0;
    user.otpLockedUntil = null;
    user.otpResendCount = 0;
    await user.save();

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

export async function resendOtp(req, res) {
  try {
    const { userId } = req.body;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ success: false });
    }

    if (user.otpResendCount >= MAX_RESENDS) {
      return res.json({
        success: false,
        code: "FLOW_ENDED"
      });
    }

    // Prevent resend before expiry
    if (user.otpExpiresAt && user.otpExpiresAt > new Date()) {
      const secondsLeft = Math.ceil((user.otpExpiresAt - new Date()) / 1000);
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

export async function loginUser(req, res, next) {
  try {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
      throw new AppError(400, "All fields are required");
    }

    const user = await User.findOne({
      $or: [{ email: identifier }, { phone: identifier }]
    });

    if (!user) {
      return res.json({
        success: false,
        message: "Account not found. Please sign up."
      });
    }

    if (user.status === "blocked") {
      return res.json({
        success: false,
        blocked: true,
        message: "Your account has been blocked by the admin. Please contact support for assistance."
      });
    }

    if (user.authType === "google") {
      return res.json({
        success: false,
        googleAccount: true,
        message: "This email is registered with Google. Please sign in using Google."
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.json({
        success: false,
        message: "Invalid password"
      });
    }

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

export async function loadSignup(req, res) {
  if (req.session.user) {
    return res.redirect("/user/home");
  }
  res.render("user/auth/signup");
}

export async function loadSignupOtp(req, res) {
  if (req.session.user) return res.redirect("/user/home");

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
    return res.redirect("/user/home");
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

export async function loadHomePage(req, res) {
  res.render("user/home", { user: req.session.user });
}

export async function loadForgotPassword(req, res) {
  res.render("user/auth/forgot-password");
}

export async function forgotPassword(req, res) {
  try {
    const { email } = req.body;

    if (!email || !email.trim()) {
      return res.json({ success: false, message: "Email is required" });
    }

    const cleanEmail = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(cleanEmail)) {
      return res.json({ success: false, message: "Enter a valid email address" });
    }

    const user = await User.findOne({ email: cleanEmail });

    if (!user) {
      return res.json({ success: false, message: "No account found with this email" });
    }

    if (user.authType === "google") {
      return res.json({
        success: false,
        googleAccount: true,
        message: "This account was created using Google. Please sign in with Google."
      });
    }

    user.otpResendCount = 0;
    user.otpAttempts = 0;
    user.otpLockedUntil = null;

    await generateAndSendOtp(user);

    req.session.allowForgotOtp = user._id.toString();

    return res.json({ success: true, userId: user._id });

  } catch (err) {
    console.error(err);
    return res.json({ success: false, message: "Something went wrong" });
  }
}

export async function verifyForgotOtp(req, res) {
  try {
    const { userId, otp } = req.body;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ success: false });
    }

    // OTP expired
    if (!user.otpExpiresAt || user.otpExpiresAt < new Date()) {
      return res.json({ success: false, code: "OTP_EXPIRED" });
    }

    // Wrong OTP
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

    // SUCCESS — clear OTP fields
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

export async function resendForgotOtp(req, res) {
  try {
    const { userId } = req.body;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Prevent resend before expiry
    if (user.otpExpiresAt && user.otpExpiresAt > new Date()) {
      const secondsLeft = Math.ceil((user.otpExpiresAt - new Date()) / 1000);
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
    console.error(err);
    return res.status(500).json({ success: false, message: "Resend failed" });
  }
}

export async function loadResetPassword(req, res) {
  try {
    const userId = req.query.userId;

    if (!userId || req.session.allowReset !== userId) {
      return res.redirect("/user/forgot-password");
    }

    const user = await User.findById(userId);

    // otp must be null — meaning OTP was successfully verified
    if (!user || user.otp !== null) {
      return res.redirect("/user/forgot-password");
    }

    req.session.allowReset = null;

    res.render("user/auth/reset-password", { userId: user._id });

  } catch {
    return res.redirect("/user/forgot-password");
  }
}

export async function resetPassword(req, res) {
  try {
    const { userId, password, confirmPassword } = req.body;

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

    const hashedPassword = await bcrypt.hash(password, 10);

    user.password = hashedPassword;
    user.otp = null;
    user.otpExpiresAt = null;
    await user.save();

    return res.json({
      success: true,
      message: "Password reset successful",
      redirect: "/user/login"
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: "Reset failed" });
  }
}