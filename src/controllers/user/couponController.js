import Coupon from "../../model/couponModel.js";
import Category from "../../model/categoryModel.js";

export const getCouponsPage = async (req, res) => {
  try {
    const now = new Date();
    const [coupons, categories] = await Promise.all([
      Coupon.find({
        status:    "active",
        isDeleted: false,
        endDate:   { $gt: now },
      }).sort({ createdAt: -1 }).lean(),
      Category.find({ isDeleted: false, isActive: true }).lean()
    ]);


    res.render("user/pages/coupons", { 
      user: req.session?.user || null, 
      coupons,
      categories
    });
  } catch (error) {
    console.error("getCouponsPage error:", error);
    res.status(500).render("user/404notfound", { user: req.session?.user || null });
  }
};

