import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  service: "Gmail",
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

async function sendMail(to, subject, message) {
  await transporter.sendMail({
    from: process.env.MAIL_USER,
    to,
    subject,
    html: message,
  });
}

export default sendMail