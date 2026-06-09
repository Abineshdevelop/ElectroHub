import Coupon from '../../model/couponModel.js';

const PER_PAGE = 10;

export const getCoupons = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    await Coupon.updateMany(
      { isDeleted: false, status: { $nin: ['expired', 'disabled'] }, endDate: { $lt: today } },
      { $set: { status: 'expired' } }
    );

    const tab    = req.query.tab || 'all';
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const isAjax = req.query.ajax === '1';

    const filter = { isDeleted: false };
    if (tab !== 'all') filter.status = tab;

    const total      = await Coupon.countDocuments(filter);
    const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
    const safePage   = Math.min(page, totalPages);
    const skip       = (safePage - 1) * PER_PAGE;

    const coupons = await Coupon.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(PER_PAGE)
      .lean();

    const showingFrom = total === 0 ? 0 : skip + 1;
    const showingTo   = Math.min(skip + PER_PAGE, total);

    if (isAjax) {
      return res.json({ coupons, currentPage: safePage, totalPages, total, showingFrom, showingTo });
    }

    res.render('admin/coupons', { coupons, tab, currentPage: safePage, totalPages, total, showingFrom, showingTo });
  } catch (err) {
    console.error(err);
    if (req.query.ajax === '1') return res.status(500).json({ success: false, message: 'Server error.' });
    res.status(500).render('error', { message: 'Failed to load coupons.' });
  }
};

export const getCouponById = async (req, res) => {//for edit the coupon
  try {
    const coupon = await Coupon.findOne({ _id: req.params.id, isDeleted: false }).lean();
    if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found.' });
    res.json({ success: true, coupon });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

export const createCoupon = async (req, res) => {
  try {
    const { couponName, code, discountType, discountValue, minPurchaseAmount, maxDiscountAmount, startDate, endDate, status } = req.body;

    if (!couponName || !code || !discountValue || !startDate || !endDate)
      return res.status(400).json({ success: false, message: 'All required fields must be filled.' });

    const cleanCode = code.trim().toUpperCase();
    if (!/^[A-Z0-9]+$/.test(cleanCode))
      return res.status(400).json({ success: false, message: 'Code must contain only letters and numbers.' });
    if (cleanCode.length > 12)
      return res.status(400).json({ success: false, message: 'Code must be 12 characters or less.' });

    const discount = Number(discountValue);
    const minP = Number(minPurchaseAmount);
    if (isNaN(discount) || discount < 1)
      return res.status(400).json({ success: false, message: 'Discount must be at least 1.' });
    if (discountType === 'percentage' && discount > 100)
      return res.status(400).json({ success: false, message: 'Percentage discount cannot exceed 100%.' });

    if (discountType === 'flat') {
      if (discount >= minP)
        return res.status(400).json({success: false,message: 'Flat discount must be less than the minimum purchase amount.'});
    }
    
    if (isNaN(minP) || minP <= 0)
      return res.status(400).json({ success: false, message: 'Minimum purchase must be greater than 0.' });
    if (minP > 1000000)
      return res.status(400).json({ success: false, message: 'Minimum purchase cannot exceed ₹10,00,000.' });

    if (discountType === 'percentage') {
      const maxD = Number(maxDiscountAmount);
      if(minPurchaseAmount<=maxD){
         return res.status(400).json({success:false, message: "minimum purchase amount should be greater that max discount valueZ"})
      }
      if (isNaN(maxD) || maxD <= 0)
        return res.status(400).json({ success: false, message: 'Max discount is required for percentage coupons.' });
      if (maxD > 100000)
        return res.status(400).json({ success: false, message: 'Max discount cannot exceed ₹1,00,000.' });
    }

    const start = new Date(startDate);
    const end   = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    if (isNaN(start) || isNaN(end))
      return res.status(400).json({ success: false, message: 'Invalid dates.' });
    if (end <= start)
      return res.status(400).json({ success: false, message: 'End date must be after start date.' });

    const existing = await Coupon.findOne({ code: cleanCode });
    if (existing)
      return res.status(400).json({ success: false, message: `Coupon code "${cleanCode}" already exists.` });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const resolvedStatus = end < today ? 'expired' : (status || 'active');

    await new Coupon({
      couponName:        couponName.trim().toUpperCase(),
      code:              cleanCode,
      discountType:      discountType || 'percentage',
      discountValue:     discount,
      minPurchaseAmount: minP,
      maxDiscountAmount: Number(maxDiscountAmount),
      startDate:         start,
      endDate:           end,
      status:            resolvedStatus,
      isDeleted:         false,
    }).save();

    res.json({ success: true, message: 'Coupon created successfully.' });
  } catch (err) {
    if (err.code === 11000)
      return res.status(400).json({ success: false, message: 'Coupon code already exists.' });
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

export const editCoupon = async (req, res) => {
  try {
    const { couponName, code, discountType, discountValue, minPurchaseAmount, maxDiscountAmount, startDate, endDate, status } = req.body;

    const coupon = await Coupon.findOne({ _id: req.params.id, isDeleted: false });
    if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found.' });

    if (!couponName || !code || !discountValue || !startDate || !endDate)
      return res.status(400).json({ success: false, message: 'All required fields must be filled.' });

    const cleanCode = code.trim().toUpperCase();
    if (!/^[A-Z0-9]+$/.test(cleanCode))
      return res.status(400).json({ success: false, message: 'Code must contain only letters and numbers.' });
    if (cleanCode.length > 12)
      return res.status(400).json({ success: false, message: 'Code must be 12 characters or less.' });

    const discount = Number(discountValue);
    if (isNaN(discount) || discount < 1)
      return res.status(400).json({ success: false, message: 'Discount must be at least 1.' });
    if (discountType === 'percentage' && discount > 100)
      return res.status(400).json({ success: false, message: 'Percentage discount cannot exceed 100%.' });

    const minP = Number(minPurchaseAmount);
    if (isNaN(minP) || minP <= 0)
      return res.status(400).json({ success: false, message: 'Minimum purchase must be greater than 0.' });
    if (minP > 1000000)
      return res.status(400).json({ success: false, message: 'Minimum purchase cannot exceed ₹10,00,000.' });

    if (discountType === 'percentage') {
      const maxD = Number(maxDiscountAmount);
      if (isNaN(maxD) || maxD <= 0)
        return res.status(400).json({ success: false, message: 'Max discount is required for percentage coupons.' });
      if (maxD > 100000)
        return res.status(400).json({ success: false, message: 'Max discount cannot exceed ₹1,00,000.' });
    }


    //validation post coupon
    const start = new Date(startDate);
    const end   = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    if (isNaN(start) || isNaN(end))
      return res.status(400).json({ success: false, message: 'Invalid dates.' });
    if (end <= start)
      return res.status(400).json({ success: false, message: 'End date must be after start date.' });

    const duplicate = await Coupon.findOne({ _id: { $ne: req.params.id }, code: cleanCode });
    if (duplicate)
      return res.status(400).json({ success: false, message: `Coupon code "${cleanCode}" already exists.` });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const resolvedStatus = end < today ? 'expired' : (status || 'active');

    coupon.couponName        = couponName.trim();
    coupon.code              = cleanCode;
    coupon.discountType      = discountType || 'percentage';
    coupon.discountValue     = discount;
    coupon.minPurchaseAmount = minP;
    coupon.maxDiscountAmount = Number(maxDiscountAmount);
    coupon.startDate         = start;
    coupon.endDate           = end;
    coupon.status            = resolvedStatus;

    await coupon.save();
    res.json({ success: true, message: 'Coupon updated successfully.' });
  } catch (err) {
    if (err.code === 11000)
      return res.status(400).json({ success: false, message: 'Coupon code already exists.' });
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

export const toggleCoupon = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    await Coupon.updateMany(
      { isDeleted: false, status: { $nin: ['expired', 'disabled'] }, endDate: { $lt: today } },
      { $set: { status: 'expired' } }
    );

    const coupon = await Coupon.findOne({ _id: req.params.id, isDeleted: false });
    if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found.' });
    if (coupon.status === 'expired')
      return res.status(400).json({ success: false, message: 'Expired coupons cannot be toggled.' });

    if (coupon.status === 'active') {
    coupon.status = 'disabled';
    } else {
    coupon.status = 'active';
    }
    await coupon.save();

    res.json({ success: true, status: coupon.status, code: coupon.code, message: coupon.status === 'active' ? 'Coupon enabled.' : 'Coupon disabled.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

export const deleteCoupon = async (req, res) => {
  try {
    const coupon = await Coupon.findOne({ _id: req.params.id, isDeleted: false });
    if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found.' });

    coupon.isDeleted = true;
    await coupon.save();

    res.json({ success: true, message: 'Coupon deleted successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};