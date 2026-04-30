import User from "../../model/usermodel.js"
import Address from "../../model/addressModel.js"
import Order from "../../model/orderModel.js"
import path from "path"
import fs from "fs"
import sendMail from "../../services/mailService.js"
import bcrypt from "bcryptjs"
import { generateReferralToken } from "./auth.controller.js";

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function logoutUser (req, res){
  delete req.session.user;
  req.session.save((err) => {
    if (err) console.error("Session save error during profile logout:", err);
    res.redirect("/user/login");
  });
};

export async function loadDashboard (req, res){
  try {
    const userId = req.session.user._id;
    let user = await User.findById(userId)
      .select("firstName lastName email phone profileImage referralToken isReferralUsed");
    
    if (!user) return res.redirect("/user/login");

    // Generate token for existing users who don't have one
    if (!user.referralToken) {
      user.referralToken = await generateReferralToken();
      await user.save();
    }

    const userObj = user.toObject();
    const defaultAddress = await Address.findOne({ userId, isDefault: true }).lean();

    // Fetch Real Stats
    const totalOrders = await Order.countDocuments({ userId });
    const pendingOrders = await Order.countDocuments({ 
        userId, 
        orderStatus: { $in: ["pending", "confirmed", "processing", "shipped", "out_for_delivery"] } 
    });
    const completedOrders = await Order.countDocuments({ 
        userId, 
        orderStatus: "delivered" 
    });

    const stats = { totalOrders, pendingOrders, completedOrders };

    // Fetch Last Order for Tracking Banner
    const lastOrder = await Order.findOne({ userId }).sort({ createdAt: -1 }).lean();
    const recentOrder = lastOrder ? {
        id: lastOrder.orderId,
        status: lastOrder.orderStatus.replace(/_/g, " ").toUpperCase()
    } : { id: "N/A", status: "No recent orders" };

    const wishlist = []; // Wishlist logic skipped as not requested

    return res.render("user/userProfile/dashboard", {
      user: userObj,
      referralToken: user.referralToken,
      stats, 
      wishlist, 
      recentOrder, 
      defaultAddress, 
      activePage: "dashboard",
    });
  } catch (err) {
    console.error("Dashboard error:", err);
    return res.redirect("/user/login");
  }
};

export async function loadAddress (req, res){
  try {
    const userId = req.session.user._id;
    const user = await User.findById(userId)
      .select("firstName lastName email profileImage")
      .lean();
    const addresses = await Address.find({ userId })
      .sort({ isDefault: -1, createdAt: 1 })
      .lean();
    res.render("user/userProfile/address", { 
      addresses, 
      user, 
      activePage: "address"  //add activePage
    });
  } catch (err) {
    console.error("Load address error:", err);
    res.redirect("/user/profile");
  }
};

export async function addAddress(req, res){
  try {
    const userId = req.session.user._id;
    const { firstName, lastName, phone, email, address, street, state, country, pincode } = req.body;

    if (!firstName?.trim() || !lastName?.trim() || !phone?.trim() ||
        !email?.trim() || !address?.trim() || !street?.trim() ||
        !state?.trim() || !country?.trim() || !pincode?.trim()) {
      return res.json({ success: false, message: "All fields are required" });
    }

    const phoneRegex = /^\d{10}$/;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!phoneRegex.test(phone.trim()))
      return res.json({ success: false, message: "Enter a valid 10-digit phone number" });
    if (!emailRegex.test(email.trim()))
      return res.json({ success: false, message: "Enter a valid email address" });

    const existingCount = await Address.countDocuments({ userId });
    const isDefault = existingCount === 0;

    await Address.create({
      userId,
      firstName: firstName.trim(), lastName: lastName.trim(),
      phone: phone.trim(), email: email.trim().toLowerCase(),
      address: address.trim(), street: street.trim(),
      state: state.trim(), country: country.trim(),
      pincode: pincode.trim(), isDefault,
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("Add address error:", err);
    return res.json({ success: false, message: "Something went wrong" });
  }
};

export async function updateAddress (req, res){
  try {
    const userId = req.session.user._id;
    const addressId = req.params.id;
    const { firstName, lastName, phone, email, address, street, state, country, pincode } = req.body;

    if (!firstName?.trim() || !lastName?.trim() || !phone?.trim() ||
        !email?.trim() || !address?.trim() || !street?.trim() ||
        !state?.trim() || !country?.trim() || !pincode?.trim()) {
      return res.json({ success: false, message: "All fields are required" });
    }

    const phoneRegex = /^\d{10}$/;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!phoneRegex.test(phone.trim()))
      return res.json({ success: false, message: "Enter a valid 10-digit phone number" });
    if (!emailRegex.test(email.trim()))
      return res.json({ success: false, message: "Enter a valid email address" });

    const updated = await Address.findOneAndUpdate(
      { _id: addressId, userId },
      {
        $set: {
          firstName: firstName.trim(), lastName: lastName.trim(),
          phone: phone.trim(), email: email.trim().toLowerCase(),
          address: address.trim(), street: street.trim(),
          state: state.trim(), country: country.trim(),
          pincode: pincode.trim(),
        },
      },
      { returnDocument: "after" }
    );

    if (!updated) return res.json({ success: false, message: "Address not found" });
    return res.json({ success: true });
  } catch (err) {
    console.error("Update address error:", err);
    return res.json({ success: false, message: "Something went wrong" });
  }
};

export async function deleteAddress (req, res){
  try {
    const userId = req.session.user._id;
    const addressId = req.params.id;
    const address = await Address.findOne({ _id: addressId, userId });
    if (!address) return res.json({ success: false, message: "Address not found" });

    await Address.deleteOne({ _id: addressId, userId });
    return res.json({ success: true });
  } catch (err) {
    console.error("Delete address error:", err);
    return res.json({ success: false, message: "Something went wrong" });
  }
};

export async function setDefaultAddress (req, res){
  try {
    const userId = req.session.user._id;
    const addressId = req.params.id;

    await Address.updateMany({ userId }, { $set: { isDefault: false } });
    const updated = await Address.findOneAndUpdate(
      { _id: addressId, userId },
      { $set: { isDefault: true } },
      { returnDocument: "after" }
    );

    if (!updated) return res.json({ success: false, message: "Address not found" });
    return res.json({ success: true });
  } catch (err) {
    console.error("Set default address error:", err);
    return res.json({ success: false, message: "Something went wrong" });
  }
};

export async function removeDefaultAddress(req, res) {
  try {
    const userId = req.session.user._id;
    const addressId = req.params.id;
    const updated = await Address.findOneAndUpdate(
      { _id: addressId, userId },
      { $set: { isDefault: false } },
      { returnDocument: "after" }
    );
    if (!updated) return res.json({ success: false, message: "Address not found" });
    return res.json({ success: true });
  } catch (err) {
    console.error("Remove default error:", err);
    return res.json({ success: false, message: "Something went wrong" });
  }
};

export async function loadProfile (req, res) {
  try {
    const userId = req.session.user._id;
    const user = await User.findById(userId);
    if (!user) return res.redirect("/user/login");

    if (!user.referralToken) {
      user.referralToken = await generateReferralToken();
      await user.save();
    }

    const defaultAddress = await Address.findOne({ userId, isDefault: true }).lean();
    res.render("user/userProfile/userAccount", { 
      user: user.toObject(), 
      referralToken: user.referralToken,
      isReferralUsed: user.isReferralUsed,
      defaultAddress,
      activePage: "profile"
    });
  } catch (err) {
    console.error("Load profile error:", err);
    return res.redirect("/user/dashboard");
  }
};

export async function updateAvatar (req, res) {
  try {
    if (!req.file) return res.redirect("/user/profile");
    const user = await User.findById(req.session.user._id);
    if (user.profileImage) {
      const publicDir = path.join(__dirname, "../../public");
      const oldPath = path.join(publicDir, user.profileImage.replace("/uploads", "uploads"));
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    user.profileImage = `/uploads/profile/${req.file.filename}`;
    await user.save();
    res.redirect("/user/profile");
  } catch (err) {
    console.error("Profile image update error:", err);
    res.redirect("/user/profile");
  }
};

 export async function removeAvatar (req, res) {
  try {
    const user = await User.findById(req.session.user._id);
    if (user.profileImage) {
      const publicDir = path.join(__dirname, "../../public");
      const filePath = path.join(publicDir, user.profileImage.replace("/uploads", "uploads"));
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    user.profileImage = null;
    await user.save();
    res.redirect("/user/profile");
  } catch (err) {
    console.error("Profile image remove error:", err);
    res.redirect("/user/profile");
  }
};

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export async function requestEmailChangeOtp (req, res){
  try {
    const userId = req.session.user._id;
    const { newEmail, isResend } = req.body;

    if (!isResend) {
      if (!newEmail || !emailRegex.test(newEmail)) {
        return res.json({ success: false, message: "Enter a valid email address" });
      }
    }

    const user = await User.findById(userId);
    if (!user) return res.status(401).json({ success: false, message: "Unauthorized" });

    if (user.authProvider === "google") {
      return res.status(403).json({ success: false, message: "Google users cannot change email" });
    }

    const emailToUse = isResend ? user.pendingEmail : newEmail?.toLowerCase();

    if (!emailToUse) {
      return res.json({ success: false, message: "No pending email found. Please start over." });
    }

    if (!isResend) {
      if (emailToUse === user.email.toLowerCase()) {
        return res.json({ success: false, message: "New email must be different from your current email" });
      }

      const exists = await User.findOne({ email: emailToUse });
      if (exists) {
        return res.json({ success: false, message: "Email already in use" });
      }
    }

    if (
      !isResend &&
      user.emailChangeOtp &&
      user.emailChangeOtpExpires &&
      user.emailChangeOtpExpires > new Date()
    ) {
      return res.json({ success: false, message: "OTP already sent. Please wait for it to expire." });
    }

    const otp = generateOtp();
    user.emailChangeOtp = otp;
    user.emailChangeOtpExpires = new Date(Date.now() + 2 * 60 * 1000);
    user.emailChangeOtpAttempts = 0;
    if (!isResend) user.pendingEmail = emailToUse;

    await user.save();

    console.log("OTP is", otp);

    await sendMail(
      emailToUse,
      "ElectroHub – Verify your new email",
      `<p>Your OTP to change email is <b>${otp}</b>. It expires in 2 minutes.</p>`
    );

    return res.json({ success: true, message: "OTP sent to new email" });
  } catch (err) {
    console.error("Request email OTP error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

export async function verifyEmailChangeOtp(req, res){
  try {
    const userId = req.session.user?._id;
    if (!userId) return res.status(401).json({ success: false, message: "Session expired. Please login again." });

    const { otp } = req.body;
    if (!otp) return res.json({ success: false, message: "OTP required" });

    const user = await User.findById(userId);
    if (!user) return res.status(401).json({ success: false, message: "Unauthorized" });

    if (!user.emailChangeOtp || !user.emailChangeOtpExpires || !user.pendingEmail) {
      return res.json({ success: false, message: "No OTP request found. Please request a new OTP." });
    }

    if (user.emailChangeOtpExpires < new Date()) {
      //Keep pendingEmail so resend works without re-entering new email
      user.emailChangeOtp = null;
      user.emailChangeOtpExpires = null;
      user.emailChangeOtpAttempts = 0;
      // pendingEmail kept intentionally
      await user.save();
      return res.json({ success: false, message: "OTP expired. Please request a new one." });
    }

    if (user.emailChangeOtpAttempts >= 5) {
      //Keep pendingEmail so resend works
      user.emailChangeOtp = null;
      user.emailChangeOtpExpires = null;
      user.emailChangeOtpAttempts = 0;
      // pendingEmail kept intentionally
      await user.save();
      return res.json({ success: false, message: "Too many wrong attempts. Please request a new OTP." });
    }

    if (user.emailChangeOtp !== otp) {
      user.emailChangeOtpAttempts += 1;
      await user.save();
      const attemptsLeft = 5 - user.emailChangeOtpAttempts;
      return res.json({
        success: false,
        message: attemptsLeft > 0
          ? `Wrong OTP. ${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} left.`
          : "Too many wrong attempts. Please request a new OTP.",
      });
    }

    // OTP correct — update email
    user.email = user.pendingEmail;
    user.pendingEmail = null;
    user.emailChangeOtp = null;
    user.emailChangeOtpExpires = null;
    user.emailChangeOtpAttempts = 0;
    await user.save();

    req.session.user.email = user.email;
    return res.json({ success: true, message: "Email updated successfully" });
  } catch (err) {
    console.error("Verify email OTP error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// ── Update Profile Details ─────────────────────────────────────
export async function updateProfileDetails(req, res){
  try {
    const userId = req.session.user._id;
    const { firstName, lastName } = req.body;

    if (!firstName?.trim() || !lastName?.trim()) {
      return res.json({ success: false, message: "First and last name are required" });
    }

    await User.findByIdAndUpdate(userId, {
      $set: { firstName: firstName.trim(), lastName: lastName.trim() },
    });

    req.session.user.firstName = firstName.trim();
    req.session.user.lastName = lastName.trim();

    return res.json({ success: true, message: "Profile updated" });
  } catch (err) {
    console.error("Update profile error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// ── Request OTP for Password Change ───────────────────────────
export async function requestPasswordChangeOtp (req, res){
  try {
    if (!req.session?.user?._id) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized access. Please login again."
      });
    }

    const userId = req.session.user._id;
    const { currentPassword, newPassword, isResend } = req.body;

    const user = await User.findById(userId).select("+password");

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User not found or session expired."
      });
    }

    // 🔹 Block Google-auth users
    if (user.authType === "google") {
      return res.status(403).json({
        success: false,
        message: "Password change is not allowed for Google-authenticated accounts."
      });
    }

    // 🔹 Ensure password exists
    if (!user.password) {
      return res.status(400).json({
        success: false,
        message: "Password is not set for this account."
      });
    }

    if (isResend) {
      // 🔹 On resend, skip validations but ensure pending password exists
      if (!user.pendingPassword) {
        return res.status(400).json({
          success: false,
          message: "Session expired. Please restart the password change process."
        });
      }
    } else {
      // 🔹 First request validations

      if (!currentPassword || !newPassword) {
        return res.status(400).json({
          success: false,
          message: "Current password and new password are required."
        });
      }

      const isCurrentValid = await bcrypt.compare(currentPassword, user.password);
      if (!isCurrentValid) {
        return res.status(400).json({
          success: false,
          message: "Current password is incorrect."
        });
      }

      const isSamePassword = await bcrypt.compare(newPassword, user.password);
      if (isSamePassword) {
        return res.status(400).json({
          success: false,
          message: "New password must be different from your current password."
        });
      }

      // 🔹 Prevent duplicate OTP before expiry
      if (
        user.passwordChangeOtp &&
        user.passwordChangeOtpExpires &&
        user.passwordChangeOtpExpires > new Date()
      ) {
        return res.status(429).json({
          success: false,
          message: "An OTP has already been sent. Please wait until it expires."
        });
      }
    }

    // 🔹 Generate OTP
    const otp = generateOtp();

    user.passwordChangeOtp = otp;
    user.passwordChangeOtpExpires = new Date(Date.now() + 2 * 60 * 1000);
    user.passwordChangeOtpAttempts = 0;

    // 🔹 Hash new password only on first request
    if (!isResend) {
      user.pendingPassword = await bcrypt.hash(newPassword, 10);
    }

    await user.save();

    await sendMail(
      user.email,
      "ElectroHub – Verify Password Change",
      `<p>Your OTP to change your password is <b>${otp}</b>. It will expire in 2 minutes.</p>`
    );

    console.log("Password Change OTP:", otp);

    return res.status(200).json({
      success: true,
      message: "OTP sent successfully to your registered email."
    });

  } catch (error) {
    console.error("Request Password Change OTP Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error. Please try again later."
    });
  }
};

export async function verifyPasswordChangeOtp (req, res){
  try {
    const userId = req.session.user._id;
    const { otp } = req.body;

    if (!otp) return res.json({ success: false, message: "OTP required" });

    const user = await User.findById(userId).select("+password");
    if (!user) return res.status(401).json({ success: false, message: "Unauthorized" });

    if (!user.passwordChangeOtp || !user.passwordChangeOtpExpires || !user.pendingPassword) {
      return res.json({ success: false, message: "No OTP request found. Please request a new OTP." });
    }

    if (user.passwordChangeOtpExpires < new Date()) {

      user.passwordChangeOtp = null;
      user.passwordChangeOtpExpires = null;
      user.passwordChangeOtpAttempts = 0;
      await user.save();
      return res.json({ success: false, message: "OTP expired. Please request a new one." });
    }

    if (user.passwordChangeOtpAttempts >= 5) {
      user.passwordChangeOtp = null;
      user.passwordChangeOtpExpires = null;
      user.passwordChangeOtpAttempts = 0;
      await user.save();
      return res.json({ success: false, message: "Too many wrong attempts. Please request a new OTP." });
    }

    if (user.passwordChangeOtp !== otp) {
      user.passwordChangeOtpAttempts += 1;
      await user.save();
      const attemptsLeft = 5 - user.passwordChangeOtpAttempts;
      return res.json({
        success: false,
        message: attemptsLeft > 0
          ? `Wrong OTP. ${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} left.`
          : "Too many wrong attempts. Please request a new OTP.",
      });
    }

    // OTP correct — update password, clear everything
    user.password = user.pendingPassword;
    user.pendingPassword = null;
    user.passwordChangeOtp = null;
    user.passwordChangeOtpExpires = null;
    user.passwordChangeOtpAttempts = 0;
    await user.save();

    return res.json({ success: true, message: "Password updated successfully" });
  } catch (err) {
    console.error("Verify password OTP error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

export async function updateAvatarAjax (req, res){
  try {
    if (!req.file) return res.json({ success: false, message: "No file uploaded" });
    const user = await User.findById(req.session.user._id);
    if (user.profileImage) {
      const publicDir = path.join(__dirname, "../../public");
      const oldPath = path.join(publicDir, user.profileImage.replace("/uploads", "uploads"));
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    user.profileImage = `/uploads/profile/${req.file.filename}`;
    await user.save();
    return res.json({ success: true, profileImage: user.profileImage });
  } catch (err) {
    console.error("Avatar AJAX upload error:", err);
    return res.json({ success: false, message: "Upload failed" });
  }
};

export async function removeAvatarAjax (req, res){
  try {
    const user = await User.findById(req.session.user._id);
    if (user.profileImage) {
      const publicDir = path.join(__dirname, "../../public");
      const filePath = path.join(publicDir, user.profileImage.replace("/uploads", "uploads"));
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    user.profileImage = null;
    await user.save();
    return res.json({ success: true, profileImage: null });
  } catch (err) {
    console.error("Avatar AJAX remove error:", err);
    return res.json({ success: false, message: "Remove failed" });
  }
};

export default {
  logoutUser,
  loadDashboard,
  loadAddress,
  addAddress,
  updateAddress,
  deleteAddress,
  setDefaultAddress,
  removeDefaultAddress,
  loadProfile,
  updateAvatar,
  removeAvatar,
  requestEmailChangeOtp,
  verifyEmailChangeOtp,
  updateProfileDetails,
  requestPasswordChangeOtp,
  verifyPasswordChangeOtp,
  updateAvatarAjax,
  removeAvatarAjax
};