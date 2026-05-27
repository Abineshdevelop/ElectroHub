import { AppError } from "../../errors/appError.js";
import Address from "../../model/addressModel.js";

export async function loadAddress(req, res, next) {
  try {
    const userId = req.session.user._id;
    const addresses = await Address.find({ userId }).sort({ createdAt: -1 });
    res.render("user/userProfile/address", {
      addresses,
      user: req.user || req.session?.user || null,
      error: null,
      success: null,
      activePage: "address",
    });
  } catch (err) {
    next(err);
  }
}

export async function addAddress(req, res, next) {
  try {
    const userId = req.session.user._id;

    let {
      firstName,
      lastName,
      phone,
      email,
      address,
      street,
      state,
      country,
      pincode,
    } = req.body;

    firstName = firstName?.trim();
    lastName = lastName?.trim();
    phone = phone?.trim();
    email = email?.trim().toLowerCase();
    address = address?.trim();
    street = street?.trim();
    state = state?.trim();
    country = country?.trim();
    pincode = pincode?.trim();

    if (
      !firstName ||
      !lastName ||
      !phone ||
      !email ||
      !address ||
      !street ||
      !state ||
      !country ||
      !pincode
    ) {
      throw new AppError(400, "All fields are required");
    }

    const phoneRegex = /^\d{10}$/;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!phoneRegex.test(phone)) {
      throw new AppError(400, "Invalid phone number");
    }

    if (!emailRegex.test(email)) {
      throw new AppError(400, "Invalid email address");
    }

    await Address.create({
      userId,
      firstName,
      lastName,
      phone,
      email,
      address,
      street,
      state,
      country,
      pincode,
    });
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

export async function setDefaultAddress(req, res, next) {
  try {
    const userId = req.session.user._id;
    const addressId = req.params.id;

    // Remove default from all
    await Address.updateMany({ userId }, { $set: { isDefault: false } });

    // Set selected one as default
    await Address.findOneAndUpdate(
      { _id: addressId, userId },
      { $set: { isDefault: true } },
    );

    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

export async function deleteAddress(req, res, next) {
  try {
    const userId = req.session.user._id;
    const addressId = req.params.id;

    const address = await Address.findOne({ _id: addressId, userId });

    if (!address) {
      throw new AppError(404, "Address not found");
    }

    await Address.deleteOne({ _id: addressId, userId });

    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

export async function updateAddress(req, res, next) {
  try {
    const userId = req.session.user._id;
    const addressId = req.params.id;

    let {
      firstName,
      lastName,
      phone,
      email,
      address,
      street,
      state,
      country,
      pincode,
    } = req.body;

    firstName = firstName?.trim();
    lastName = lastName?.trim();
    phone = phone?.trim();
    email = email?.trim().toLowerCase();
    address = address?.trim();
    street = street?.trim();
    state = state?.trim();
    country = country?.trim();
    pincode = pincode?.trim();

    if (
      !firstName ||
      !lastName ||
      !phone ||
      !email ||
      !address ||
      !street ||
      !state ||
      !country ||
      !pincode
    ) {
      throw new AppError(400, "All fields are required");
    }

    const phoneRegex = /^\d{10}$/;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!phoneRegex.test(phone)) throw new AppError(400, "Invalid phone number");
    if (!emailRegex.test(email)) throw new AppError(400, "Invalid email address");
    const updated = await Address.findOneAndUpdate(
      { _id: addressId, userId },
      {
        firstName,
        lastName,
        phone,
        email,
        address,
        street,
        state,
        country,
        pincode,
      },
      { returnDocument: "after" },
    );

    if (!updated) throw new AppError(404, "Address not found");
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

export async function removeDefaultAddress(req, res, next) {
  try {
    const userId = req.session.user._id;
    const addressId = req.params.id;

    const updated = await Address.findOneAndUpdate(
      { _id: addressId, userId },
      { $set: { isDefault: false } },
      { returnDocument: "after" },
    );

    if (!updated) {
      throw new AppError(404, "Address not found");
    }

    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

export default {
  loadAddress,
  addAddress,
  setDefaultAddress,
  deleteAddress,
  updateAddress,
  removeDefaultAddress,
};
