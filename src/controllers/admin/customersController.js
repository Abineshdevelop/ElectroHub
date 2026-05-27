import { AppError } from "../../errors/appError.js";
import User from "../../model/usermodel.js";

export async function getCustomers(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = 8;
    const skip = (page - 1) * limit;
    const searchQuery = (req.query.q || "").trim();
    const isAjax = req.query.ajax === "1";
    const sort = ["asc", "desc"].includes(req.query.sort) ? req.query.sort : "desc";
    const sortOrder = sort === "asc" ? 1 : -1;

    const filter = {
      deletedAt: null,
      ...(searchQuery && {
        $or: [
          { firstName: { $regex: searchQuery, $options: "i" } },
          { lastName:  { $regex: searchQuery, $options: "i" } },
          { email:     { $regex: searchQuery, $options: "i" } },
          { phone:     { $regex: searchQuery, $options: "i" } },
        ],
      }),
    };

    const [users, totalCustomers] = await Promise.all([
      User.find(filter).sort({ createdAt: sortOrder }).skip(skip).limit(limit).lean(),
      User.countDocuments(filter),
    ]);

    const totalPages  = Math.max(Math.ceil(totalCustomers / limit), 1);
    const safePage    = Math.min(page, totalPages);
    const showingFrom = totalCustomers ? (safePage - 1) * limit + 1 : 0;
    const showingTo   = Math.min(safePage * limit, totalCustomers);

    if (isAjax) {
      return res.json({ users, total: totalCustomers, totalPages, currentPage: safePage, showingFrom, showingTo, q: searchQuery, sort });
    }

    if (page !== safePage) {
      const params = new URLSearchParams();
      params.set("page", safePage);
      if (searchQuery) {
        params.set("q", searchQuery);
      }
      params.set("sort", sort);
      return res.redirect(`/admin/customers?${params.toString()}`);
    }

    return res.render("admin/auth/customers", {
      users,
      currentPage: safePage,
      totalPages,
      total: totalCustomers,
      limit,
      query: searchQuery,
      sort,
      showingFrom,
      showingTo,
    });
  } catch (error) {
    next(error);
  }
}

export async function blockUser(req, res, next) {
  try {
    const { id } = req.params;

    const user = await User.findById(id).select("isAdmin status");
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    if (user.isAdmin) {
      return res.status(403).json({ success: false, message: "Admin users cannot be blocked" });
    }
    if (user.status === "blocked") {
      return res.json({ success: true, message: "User already blocked" });
    }

    await User.findByIdAndUpdate(id, { $set: { status: "blocked" } });

    return res.json({ success: true, message: "User blocked successfully" });
  } catch (error) {
    next(error);
  }
}

export async function unblockUser(req, res, next) {
  try {
    const { id } = req.params;

    const user = await User.findById(id).select("status");
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    if (user.status === "active") {
      return res.json({ success: true, message: "User already active" });
    }

    await User.findByIdAndUpdate(id, { $set: { status: "active" } });

    return res.json({ success: true, message: "User unblocked successfully" });
  } catch (error) {
    next(error);
  }
}

export async function deleteUser(req, res, next) {
  try {
    const { id } = req.params;

    const user = await User.findById(id);
    if (!user) {
      throw new AppError(404, "User not found");
    }
    if (user.isAdmin) {
      throw new AppError(403, "Admin users cannot be deleted");
    }

    await User.findByIdAndDelete(id);
    return res.json({ success: true, message: "User deleted successfully" });
  } catch (error) {
    next(error);
  }
}

export default { getCustomers, blockUser, unblockUser, deleteUser };