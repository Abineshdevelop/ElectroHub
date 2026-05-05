import express from "express";
import adminController from "../../controllers/admin/admincontroller.js";
import * as customersController from "../../controllers/admin/customersController.js";
import { isAdminLoggedIn, isAdminLoggedOut } from "../../middlewares/adminAuth.js";
import { getCategories, createCategory, getCategoryById, updateCategory, toggleCategoryStatus, deleteCategory } from "../../controllers/admin/categoriescontroller.js";
import { getProducts, getProductById, createProduct, updateProduct, deleteProduct, toggleProductsStauts, toggleVariantStatus } from '../../controllers/admin/productsController.js';
import { uploadProduct } from '../../middlewares/uploads.js';
import { getCoupons, getCouponById, createCoupon, editCoupon, deleteCoupon, toggleCoupon } from '../../controllers/admin/couponController.js';
import { getOffersPage,getOfferById, searchProducts, searchCategories, createOffer, editOffer, toggleOffer, deleteOffer } from "../../controllers/admin/offersController.js";
import { getBannersPage, getBannerById, createBanner, editBanner,  toggleBanner, deleteBanner} from "../../controllers/admin/bannerController.js";
import { uploadBanner } from "../../middlewares/uploads.js";
import { getOrders, getOrderDetail, updateOrderStatus, deleteOrder, updateItemStatus, approveReturn, rejectReturn } from '../../controllers/admin/orderController.js'
import * as salesController from "../../controllers/admin/salesReportController.js";

const router = express.Router();

router.get ("/login",     isAdminLoggedOut, adminController.showLogin);
router.post("/login",     isAdminLoggedOut, adminController.loginAdmin);
router.get ("/logout",    isAdminLoggedIn,  adminController.logoutAdmin);
router.get ("/dashboard",    isAdminLoggedIn,  adminController.adminDashboard);
router.get ("/dashboard/download/pdf",   isAdminLoggedIn, adminController.downloadPDF);
router.get ("/dashboard/download/excel", isAdminLoggedIn, adminController.downloadExcel);

router.get ("/sales-report", isAdminLoggedIn,  salesController.getSalesReport);
router.get ("/sales-report/download/pdf",   isAdminLoggedIn, salesController.downloadPDF);
router.get ("/sales-report/download/excel", isAdminLoggedIn, salesController.downloadExcel);

router.get   ("/customers",             isAdminLoggedIn, customersController.getCustomers);
router.patch ("/customers/:id/block",   isAdminLoggedIn, customersController.blockUser);
router.patch ("/customers/:id/unblock", isAdminLoggedIn, customersController.unblockUser);
router.delete("/customers/:id/delete",  isAdminLoggedIn, customersController.deleteUser);

router.get   ("/category",            isAdminLoggedIn, getCategories);
router.post  ("/category/create",     isAdminLoggedIn, createCategory);
router.get   ("/category/:id",        isAdminLoggedIn, getCategoryById);
router.put   ("/category/:id/edit",   isAdminLoggedIn, updateCategory);
router.patch ("/category/:id/toggle", isAdminLoggedIn, toggleCategoryStatus);
router.delete("/category/:id/delete", isAdminLoggedIn, deleteCategory);

router.get   ('/products',                          isAdminLoggedIn, getProducts);
router.post  ('/products/create',                   isAdminLoggedIn, uploadProduct.any(), createProduct);
router.get   ('/products/:id',                      isAdminLoggedIn, getProductById);
router.put   ('/products/:id/edit',                 isAdminLoggedIn, uploadProduct.any(), updateProduct);
router.delete('/products/:id/delete',               isAdminLoggedIn, deleteProduct);
router.patch ('/products/:id/toggle-status',        isAdminLoggedIn, toggleProductsStauts);
router.patch ('/products/:id/variants/:vid/toggle', isAdminLoggedIn, toggleVariantStatus);

router.get   ('/coupons',            isAdminLoggedIn, getCoupons);
router.post  ('/coupons/create',     isAdminLoggedIn, createCoupon);
router.get   ('/coupons/:id',        isAdminLoggedIn, getCouponById);
router.put   ('/coupons/:id/edit',   isAdminLoggedIn, editCoupon);
router.patch('/coupons/:id/toggle', isAdminLoggedIn, toggleCoupon);
router.delete('/coupons/:id/delete', isAdminLoggedIn, deleteCoupon);

router.get   ('/offers',                    isAdminLoggedIn, getOffersPage);
router.get   ('/offers/search-products',    isAdminLoggedIn, searchProducts);
router.get   ('/offers/search-categories',  isAdminLoggedIn, searchCategories);
router.post  ('/offers/create',             isAdminLoggedIn, createOffer);
router.get   ('/offers/:id',                isAdminLoggedIn, getOfferById);
router.put   ('/offers/:id/edit',           isAdminLoggedIn, editOffer);
router.patch ('/offers/:id/toggle',         isAdminLoggedIn, toggleOffer);
router.delete('/offers/:id/delete',         isAdminLoggedIn, deleteOffer);

router.get   ('/banners',            isAdminLoggedIn, getBannersPage);
router.post  ('/banners/create',     isAdminLoggedIn, uploadBanner.single('image'), createBanner);
router.get   ('/banners/:id',        isAdminLoggedIn, getBannerById);
router.put   ('/banners/:id/edit',   isAdminLoggedIn, uploadBanner.single('image'), editBanner);
router.patch ('/banners/:id/toggle', isAdminLoggedIn, toggleBanner);
router.delete('/banners/:id/delete', isAdminLoggedIn, deleteBanner);

router.get   ('/orders',             isAdminLoggedIn, getOrders);
router.get   ('/orders/:id',         isAdminLoggedIn, getOrderDetail);
router.patch ('/orders/:id/status',  isAdminLoggedIn, updateOrderStatus);
router.patch ('/orders/:id/return/approve', isAdminLoggedIn, approveReturn);
router.patch ('/orders/:id/return/reject',  isAdminLoggedIn, rejectReturn);
router.delete('/orders/:id/delete',  isAdminLoggedIn, deleteOrder);
router.patch('/orders/:id/items/:itemId/status', isAdminLoggedIn, updateItemStatus);


export default router;

