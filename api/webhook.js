// api/webhook.js
// ============================================================
// PAYSTACK WEBHOOK HANDLER - VERCEL SERVERLESS FUNCTION
// ============================================================

const admin = require('firebase-admin');

// ============================================================
// FIREBASE ADMIN INIT
// ============================================================
if (!admin.apps.length) {
    // For Vercel, use environment variables
    // You'll add FIREBASE_SERVICE_ACCOUNT in Vercel dashboard
    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT 
        ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
        : null;
    
    if (serviceAccount) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    } else {
        // Development fallback
        admin.initializeApp({
            projectId: 'timijosh-b8bee',
        });
    }
}

const db = admin.firestore();

// ============================================================
// PAYSTACK SECRET
// ============================================================
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY ||
    'sk_test_aaf7f6095e4579b17cc449df2563c096de124278';

// ============================================================
// WEBHOOK HANDLER - VERCEL FORMAT
// ============================================================
module.exports = async function(req, res) {
    // Only accept POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const body = req.body;
        const eventType = body.event;

        console.log(`Webhook received: ${eventType}`);

        // Handle different events
        switch (eventType) {
            case 'charge.success':
                await handleChargeSuccess(body.data);
                break;

            case 'charge.failed':
                await handleChargeFailed(body.data);
                break;

            case 'refund.processed':
                await handleRefund(body.data);
                break;

            default:
                console.log(`Unhandled event: ${eventType}`);
        }

        return res.status(200).json({ status: 'success' });

    } catch (error) {
        console.error('Webhook error:', error);
        return res.status(500).json({ error: error.message });
    }
};

// ============================================================
// HANDLE CHARGE SUCCESS
// ============================================================
async function handleChargeSuccess(data) {
    const reference = data.reference;
    const metadata = data.metadata || {};

    console.log(`Processing successful payment: ${reference}`);

    // Check if already processed
    const existingPayment = await db.collection('payments').doc(reference).get();
    if (existingPayment.exists) {
        console.log(`Payment ${reference} already processed`);
        return;
    }

    const totalAmount = data.amount / 100;
    const adminPercentage = await getCommissionPercentage();
    const instructorPercentage = 100 - adminPercentage;
    const adminAmount = totalAmount * (adminPercentage / 100);
    const instructorAmount = totalAmount * (instructorPercentage / 100);

    // Start a batch write
    const batch = db.batch();

    // 1. Save payment
    const paymentRef = db.collection('payments').doc(reference);
    batch.set(paymentRef, {
        reference: reference,
        userId: metadata.userId,
        courseId: metadata.courseId,
        instructorId: metadata.instructorId,
        referrerId: metadata.referrerId || null,
        amount: totalAmount,
        currency: data.currency || 'NGN',
        status: 'success',
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        paymentMethod: data.channel || 'paystack',
        fees: data.fees || 0,
        customerEmail: data.customer?.email || '',
        customerName: data.customer?.first_name || '',
        metadata: metadata,
        paymentData: data
    });

    // 2. Create commission record
    const commissionRef = db.collection('commissions').doc();
    batch.set(commissionRef, {
        paymentReference: reference,
        instructorId: metadata.instructorId,
        courseId: metadata.courseId,
        userId: metadata.userId,
        totalAmount: totalAmount,
        adminPercentage: adminPercentage,
        instructorPercentage: instructorPercentage,
        adminAmount: adminAmount,
        instructorAmount: instructorAmount,
        status: 'pending',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 3. Credit instructor
    const instructorRef = db.collection('users').doc(metadata.instructorId);
    batch.update(instructorRef, {
        'instructorEarnings.total': admin.firestore.FieldValue.increment(instructorAmount),
        'instructorEarnings.pending': admin.firestore.FieldValue.increment(instructorAmount),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 4. Create enrollment
    const enrollmentRef = db.collection('enrollments').doc();
    batch.set(enrollmentRef, {
        userId: metadata.userId,
        courseId: metadata.courseId,
        paymentReference: reference,
        status: 'active',
        paymentStatus: 'paid',
        amount: totalAmount,
        enrolledAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 5. Handle referral (2-term payment)
    if (metadata.referrerId && metadata.referrerId !== metadata.userId) {
        await handleReferralInWebhook(batch, metadata, totalAmount);
    }

    // Commit all changes
    await batch.commit();

    console.log(`✅ Payment ${reference} processed successfully`);
}

// ============================================================
// HANDLE REFERRAL IN WEBHOOK
// ============================================================
async function handleReferralInWebhook(batch, metadata, totalAmount) {
    try {
        const referralQuery = await db.collection('referrals')
            .where('referredUid', '==', metadata.userId)
            .where('referrerUid', '==', metadata.referrerId)
            .get();

        let referralDoc = null;
        let currentStatus = 'registered';

        if (!referralQuery.empty) {
            referralDoc = referralQuery.docs[0];
            currentStatus = referralDoc.data().status || 'registered';
        }

        const settings = await db.collection('settings').doc('subscription').get();
        const referralCommission = settings.exists ? settings.data().referralCommission || 20 : 20;

        let rewardAmount = 0;
        let newStatus = currentStatus;

        if (currentStatus === 'registered') {
            rewardAmount = totalAmount * (referralCommission / 100);
            newStatus = 'first_payment';
        } else if (currentStatus === 'first_payment') {
            rewardAmount = totalAmount * ((referralCommission / 2) / 100);
            newStatus = 'second_payment';
        } else {
            return;
        }

        if (rewardAmount <= 0) return;

        const referralData = {
            status: newStatus,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastPaymentAmount: totalAmount,
        };

        if (currentStatus === 'registered') {
            referralData.firstPaymentAmount = totalAmount;
            referralData.rewardAmount = rewardAmount;
        } else if (currentStatus === 'first_payment') {
            referralData.secondPaymentAmount = totalAmount;
            referralData.totalRewardAmount = admin.firestore.FieldValue.increment(rewardAmount);
        }

        if (referralDoc) {
            batch.update(referralDoc.ref, referralData);
        } else {
            const newRef = db.collection('referrals').doc();
            batch.set(newRef, {
                referrerUid: metadata.referrerId,
                referredUid: metadata.userId,
                referredName: metadata.userName || 'Student',
                referredEmail: metadata.userEmail || '',
                referralCode: metadata.referralCode || null,
                status: newStatus,
                rewardAmount: rewardAmount,
                totalRewardAmount: rewardAmount,
                firstPaymentAmount: currentStatus === 'registered' ? totalAmount : null,
                lastPaymentAmount: totalAmount,
                source: metadata.referralSource || 'direct',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        // Credit referrer
        const referrerRef = db.collection('users').doc(metadata.referrerId);
        batch.update(referrerRef, {
            'referralEarnings': admin.firestore.FieldValue.increment(rewardAmount),
            'referralPending': admin.firestore.FieldValue.increment(rewardAmount),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const rewardRef = db.collection('referral_rewards').doc();
        batch.set(rewardRef, {
            referrerId: metadata.referrerId,
            referredId: metadata.userId,
            amount: rewardAmount,
            type: currentStatus === 'registered' ? 'first_payment' : 'second_payment',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

    } catch (error) {
        console.error('Referral handling error:', error);
    }
}

// ============================================================
// HANDLE CHARGE FAILED
// ============================================================
async function handleChargeFailed(data) {
    const reference = data.reference;
    const metadata = data.metadata || {};

    console.log(`Payment failed: ${reference}`);

    await db.collection('payments').doc(reference).set({
        reference: reference,
        userId: metadata.userId || '',
        courseId: metadata.courseId || '',
        amount: data.amount / 100 || 0,
        status: 'failed',
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
        failureReason: data.gateway_response || data.message || 'Unknown error',
        metadata: metadata
    });

    console.log(`✅ Payment ${reference} marked as failed`);
}

// ============================================================
// HANDLE REFUND
// ============================================================
async function handleRefund(data) {
    const reference = data.reference;
    console.log(`Refund processed: ${reference}`);

    // Update payment status
    await db.collection('payments').doc(reference).update({
        status: 'refunded',
        refundedAt: admin.firestore.FieldValue.serverTimestamp(),
        refundData: data
    });

    // Reverse commission
    const commissionQuery = await db.collection('commissions')
        .where('paymentReference', '==', reference)
        .get();

    if (!commissionQuery.empty) {
        const commission = commissionQuery.docs[0];
        const cData = commission.data();

        // Deduct from instructor
        await db.collection('users').doc(cData.instructorId).update({
            'instructorEarnings.total': admin.firestore.FieldValue.increment(-cData.instructorAmount),
            'instructorEarnings.pending': admin.firestore.FieldValue.increment(-cData.instructorAmount),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        await commission.ref.update({
            status: 'refunded',
            refundedAt: admin.firestore.FieldValue.serverTimestamp()
        });
    }
}

// ============================================================
// HELPER: GET COMMISSION PERCENTAGE
// ============================================================
async function getCommissionPercentage() {
    try {
        const doc = await db.collection('settings').doc('commission').get();
        if (doc.exists) {
            return doc.data().adminPercentage || 30;
        }
        return 30;
    } catch (error) {
        console.error('Error getting commission:', error);
        return 30;
    }
}

// ============================================================
// HELPER: VERIFY PAYSTACK SIGNATURE
// ============================================================
function verifySignature(body, signature) {
    const crypto = require('crypto');
    const hash = crypto
        .createHmac('sha512', PAYSTACK_SECRET)
        .update(JSON.stringify(body))
        .digest('hex');
    return hash === signature;
}
