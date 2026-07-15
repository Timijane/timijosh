// ============================================================
// PAYOUT.JS - Instructor Payout Logic
// ============================================================
// This file contains shared payout functions used by both
// instructor-dashboard.html and admin-dashboard.html
// ============================================================

(function() {
    'use strict';

    const PAYOUT = {
        MIN_WITHDRAWAL: 5000, // ₦5,000 minimum
        CURRENCY: 'NGN',

        // ============================================================
        // REQUEST WITHDRAWAL
        // ============================================================
        async requestWithdrawal(instructorId, amount, bankDetails, adminNote = '') {
            if (amount < PAYOUT.MIN_WITHDRAWAL) {
                throw new Error(`Minimum withdrawal is ₦${PAYOUT.MIN_WITHDRAWAL.toLocaleString()}`);
            }

            const db = firebase.firestore();

            // Check balance
            const userDoc = await db.collection('users').doc(instructorId).get();
            if (!userDoc.exists) throw new Error('User not found');

            const earnings = userDoc.data().instructorEarnings || { pending: 0 };
            if (amount > earnings.pending) {
                throw new Error(`Insufficient balance. Available: ₦${earnings.pending.toLocaleString()}`);
            }

            // Create withdrawal request
            const withdrawalRef = await db.collection('withdrawals').add({
                instructorId: instructorId,
                instructorEmail: userDoc.data().email || '',
                instructorName: userDoc.data().fullName || 'Instructor',
                amount: amount,
                bankName: bankDetails.bankName,
                accountNumber: bankDetails.accountNumber,
                accountName: bankDetails.accountName,
                status: 'pending',
                adminNote: adminNote || '',
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            // Deduct from pending earnings
            await db.collection('users').doc(instructorId).update({
                'instructorEarnings.pending': firebase.firestore.FieldValue.increment(-amount),
                'instructorEarnings.withdrawn': firebase.firestore.FieldValue.increment(amount),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            // Log the withdrawal
            await db.collection('auditLogs').add({
                action: 'withdrawal_requested',
                instructorId: instructorId,
                amount: amount,
                withdrawalId: withdrawalRef.id,
                timestamp: firebase.firestore.FieldValue.serverTimestamp()
            });

            return withdrawalRef.id;
        },

        // ============================================================
        // ADMIN: APPROVE WITHDRAWAL
        // ============================================================
        async approveWithdrawal(withdrawalId, adminId, adminNote = '') {
            const db = firebase.firestore();
            const doc = await db.collection('withdrawals').doc(withdrawalId).get();
            if (!doc.exists) throw new Error('Withdrawal not found');

            const data = doc.data();
            if (data.status !== 'pending') {
                throw new Error(`Withdrawal is already ${data.status}`);
            }

            await doc.ref.update({
                status: 'processing',
                adminNote: adminNote || data.adminNote || '',
                approvedBy: adminId,
                approvedAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            // Log approval
            await db.collection('auditLogs').add({
                action: 'withdrawal_approved',
                withdrawalId: withdrawalId,
                instructorId: data.instructorId,
                amount: data.amount,
                approvedBy: adminId,
                timestamp: firebase.firestore.FieldValue.serverTimestamp()
            });

            return true;
        },

        // ============================================================
        // ADMIN: COMPLETE WITHDRAWAL (Payment Sent)
        // ============================================================
        async completeWithdrawal(withdrawalId, adminId, paymentReference = '') {
            const db = firebase.firestore();
            const doc = await db.collection('withdrawals').doc(withdrawalId).get();
            if (!doc.exists) throw new Error('Withdrawal not found');

            const data = doc.data();
            if (data.status !== 'processing') {
                throw new Error(`Withdrawal is not in processing state`);
            }

            await doc.ref.update({
                status: 'paid',
                paymentReference: paymentReference || `WTH-${Date.now()}`,
                completedBy: adminId,
                completedAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            // Log completion
            await db.collection('auditLogs').add({
                action: 'withdrawal_completed',
                withdrawalId: withdrawalId,
                instructorId: data.instructorId,
                amount: data.amount,
                completedBy: adminId,
                timestamp: firebase.firestore.FieldValue.serverTimestamp()
            });

            return true;
        },

        // ============================================================
        // ADMIN: CANCEL WITHDRAWAL
        // ============================================================
        async cancelWithdrawal(withdrawalId, adminId, reason = '') {
            const db = firebase.firestore();
            const doc = await db.collection('withdrawals').doc(withdrawalId).get();
            if (!doc.exists) throw new Error('Withdrawal not found');

            const data = doc.data();
            if (data.status === 'paid') {
                throw new Error('Cannot cancel a completed withdrawal');
            }

            // Refund the amount back to instructor
            await db.collection('users').doc(data.instructorId).update({
                'instructorEarnings.pending': firebase.firestore.FieldValue.increment(data.amount),
                'instructorEarnings.withdrawn': firebase.firestore.FieldValue.increment(-data.amount),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            await doc.ref.update({
                status: 'cancelled',
                adminNote: reason || data.adminNote || '',
                cancelledBy: adminId,
                cancelledAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            // Log cancellation
            await db.collection('auditLogs').add({
                action: 'withdrawal_cancelled',
                withdrawalId: withdrawalId,
                instructorId: data.instructorId,
                amount: data.amount,
                reason: reason,
                cancelledBy: adminId,
                timestamp: firebase.firestore.FieldValue.serverTimestamp()
            });

            return true;
        },

        // ============================================================
        // GET INSTRUCTOR WITHDRAWALS
        // ============================================================
        async getWithdrawals(instructorId, limit = 50) {
            const db = firebase.firestore();
            const snap = await db.collection('withdrawals')
                .where('instructorId', '==', instructorId)
                .orderBy('createdAt', 'desc')
                .limit(limit)
                .get();

            const withdrawals = [];
            snap.forEach(doc => withdrawals.push({ id: doc.id, ...doc.data() }));
            return withdrawals;
        },

        // ============================================================
        // GET ALL WITHDRAWALS (Admin)
        // ============================================================
        async getAllWithdrawals(status = null, limit = 100) {
            const db = firebase.firestore();
            let query = db.collection('withdrawals').orderBy('createdAt', 'desc');

            if (status) {
                query = query.where('status', '==', status);
            }

            const snap = await query.limit(limit).get();
            const withdrawals = [];
            snap.forEach(doc => withdrawals.push({ id: doc.id, ...doc.data() }));
            return withdrawals;
        },

        // ============================================================
        // CALCULATE EARNINGS
        // ============================================================
        async calculateEarnings(instructorId) {
            const db = firebase.firestore();

            // Get instructor's courses
            const courseSnap = await db.collection('courses')
                .where('instructorId', '==', instructorId)
                .get();

            let grossRevenue = 0;
            let totalStudents = 0;

            for (const courseDoc of courseSnap.docs) {
                const course = courseDoc.data();
                const enrollSnap = await db.collection('enrollments')
                    .where('courseId', '==', courseDoc.id)
                    .where('status', '==', 'active')
                    .get();

                const students = enrollSnap.size;
                totalStudents += students;
                grossRevenue += (course.price || 0) * students;
            }

            // Get commission settings
            const settingsSnap = await db.collection('settings').doc('commission').get();
            const adminPercentage = settingsSnap.exists ? settingsSnap.data().adminPercentage || 30 : 30;
            const instructorPercentage = 100 - adminPercentage;

            const platformFee = grossRevenue * (adminPercentage / 100);
            const netEarnings = grossRevenue - platformFee;

            return {
                grossRevenue,
                platformFee,
                netEarnings,
                adminPercentage,
                instructorPercentage,
                totalStudents,
                totalCourses: courseSnap.size
            };
        }
    };

    // Expose to global scope
    window.PAYOUT = PAYOUT;

    console.log('✅ PAYOUT.js loaded successfully');

})(); 
