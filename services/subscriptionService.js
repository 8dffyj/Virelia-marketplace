// services/subscriptionService.js (Enhanced with decimal precision support)
const { getDB, getClient } = require("../config/mongodb");
const fs = require("fs").promises;
const path = require("path");
const axios = require("axios");

// Import Discord status manager
let discordStatusManager;
try {
    discordStatusManager = require("./discordStatusManager");
} catch (error) {
    console.warn("[WARN] Discord status manager not available:", error.message);
}

// Cache for subscription plans
let plansCache = null;
let plansCacheTime = null;

class SubscriptionService {
    // Utility function to format VV amounts with proper decimal precision
    static formatVV(amount, options = {}) {
        const { 
            showDecimals = true, 
            maxDecimals = 8, 
            minDecimals = 0,
            showCommas = true 
        } = options;
        
        if (typeof amount !== 'number') {
            amount = parseFloat(amount) || 0;
        }
        
        let formattedNumber;
        
        if (showDecimals) {
            // For very small numbers, show up to maxDecimals places
            if (amount < 1 && amount > 0) {
                formattedNumber = amount.toFixed(maxDecimals).replace(/\.?0+$/, '');
            } else {
                // For larger numbers, show minimal decimals
                formattedNumber = amount.toFixed(Math.max(minDecimals, 2)).replace(/\.?0+$/, '');
            }
        } else {
            formattedNumber = Math.round(amount).toString();
        }
        
        // Add commas for thousands separator if enabled
        if (showCommas && parseFloat(formattedNumber) >= 1000) {
            formattedNumber = parseFloat(formattedNumber).toLocaleString('en-US', {
                minimumFractionDigits: 0,
                maximumFractionDigits: maxDecimals
            });
        }
        
        return formattedNumber;
    }

    // Enhanced price calculation with decimal precision
    static calculateFinalPrice(plan, returnObject = false) {
        if (!plan.discount) {
            const finalPrice = parseFloat(plan.price_vv);
            return returnObject ? { 
                finalPrice, 
                originalPrice: finalPrice, 
                discountAmount: 0,
                formattedFinal: this.formatVV(finalPrice),
                formattedOriginal: this.formatVV(finalPrice),
                formattedDiscount: '0'
            } : finalPrice;
        }

        let finalPrice;
        const originalPrice = parseFloat(plan.price_vv);

        if (plan.discount.type === "percent") {
            finalPrice = originalPrice * (1 - plan.discount.value / 100);
        } else if (plan.discount.type === "fixed") {
            finalPrice = Math.max(0, originalPrice - parseFloat(plan.discount.value));
        } else {
            finalPrice = originalPrice;
        }
        
        const discountAmount = originalPrice - finalPrice;
        
        if (returnObject) {
            return {
                finalPrice,
                originalPrice,
                discountAmount,
                formattedFinal: this.formatVV(finalPrice),
                formattedOriginal: this.formatVV(originalPrice),
                formattedDiscount: this.formatVV(discountAmount)
            };
        }
        
        return finalPrice;
    }

    static async getPlans(forceReload = false) {
        const plansPath = path.join(__dirname, "../plans/subscriptions.json");

        try {
            const stats = await fs.stat(plansPath);

            // Reload if cache is empty, forced, or file is newer
            if (
                !plansCache ||
                forceReload ||
                !plansCacheTime ||
                stats.mtime > plansCacheTime
            ) {
                const data = await fs.readFile(plansPath, "utf8");
                plansCache = JSON.parse(data);
                plansCacheTime = stats.mtime;
                console.log("[INFO] Subscription plans cache updated");
            }

            return plansCache;
        } catch (error) {
            console.error("[ERROR] Failed to load subscription plans:", error);
            return [];
        }
    }

    static formatDuration(days) {
        if (days >= 365) {
            const years = Math.floor(days / 365);
            const remainingDays = days % 365;
            if (remainingDays === 0) {
                return `${years} ${years === 1 ? "Year" : "Years"}`;
            }
            return `${years} ${years === 1 ? "Year" : "Years"} ${remainingDays} Days`;
        } else if (days >= 30) {
            const months = Math.floor(days / 30);
            const remainingDays = days % 30;
            if (remainingDays === 0) {
                return `${months} ${months === 1 ? "Month" : "Months"}`;
            }
            return `${months} ${months === 1 ? "Month" : "Months"
                } ${remainingDays} Days`;
        } else if (days >= 7) {
            const weeks = Math.floor(days / 7);
            const remainingDays = days % 7;
            if (remainingDays === 0) {
                return `${weeks} ${weeks === 1 ? "Week" : "Weeks"}`;
            }
            return `${weeks} ${weeks === 1 ? "Week" : "Weeks"} ${remainingDays} Days`;
        } else {
            return `${days} ${days === 1 ? "Day" : "Days"}`;
        }
    }

    static async purchaseSubscription(userId, planId, idempotencyKey) {
        const db = getDB();
        const client = getClient();
        const plans = await this.getPlans();
        const plan = plans.find((p) => p.id === planId);

        if (!plan) {
            throw new Error("Plan not found");
        }

        const finalPrice = parseFloat(this.calculateFinalPrice(plan));

        // Check for duplicate transaction
        const existingTx = await db.collection("transactions").findOne({
            idempotency_key: idempotencyKey,
        });
        if (existingTx) {
            throw new Error("Transaction already processed");
        }

        const session = client.startSession();

        try {
            let result;
            await session.withTransaction(async () => {
                // Get user and check balance (handle as decimal)
                const user = await db
                    .collection("users")
                    .findOne({ _id: userId }, { session });

                if (!user) {
                    throw new Error("User not found");
                }

                const userBalance = parseFloat(user.vv_balance || 0);
                console.log(
                    `[DEBUG] User ${userId} balance: ${this.formatVV(userBalance)}, required: ${this.formatVV(finalPrice)}`
                );

                if (userBalance < finalPrice) {
                    throw new Error(
                        `Insufficient VV balance. You have ${this.formatVV(userBalance)} VV but need ${this.formatVV(finalPrice)} VV`
                    );
                }

                const now = new Date();
                const planDurationMs = plan.days * 24 * 60 * 60 * 1000;

                // Check for existing active subscription
                const existingSubscription = await db
                    .collection("subscriptions")
                    .findOne(
                        {
                            user_id: userId,
                            status: "active",
                            expires_at: { $gt: now },
                        },
                        { session }
                    );

                let isRenewal = false;
                let newExpiresAt;
                let subscriptionData;

                if (existingSubscription) {
                    // This is a renewal/extension
                    isRenewal = true;
                    newExpiresAt = new Date(
                        existingSubscription.expires_at.getTime() + planDurationMs
                    );

                    // Update existing subscription instead of creating new one
                    await db.collection("subscriptions").updateOne(
                        { _id: existingSubscription._id },
                        {
                            $set: {
                                expires_at: newExpiresAt,
                                updated_at: now,
                                last_renewed_at: now,
                                last_renewal_plan_id: plan.id,
                                last_renewal_amount: finalPrice,
                            },
                            $inc: {
                                renewal_count: 1,
                                total_paid_vv: finalPrice,
                            },
                        },
                        { session }
                    );

                    // Get updated subscription data
                    subscriptionData = {
                        ...existingSubscription,
                        expires_at: newExpiresAt,
                        updated_at: now,
                        last_renewed_at: now,
                        renewal_count: (existingSubscription.renewal_count || 0) + 1,
                        total_paid_vv:
                            parseFloat(existingSubscription.total_paid_vv ||
                                existingSubscription.paid_price_vv ||
                                0) + finalPrice,
                    };
                } else {
                    // New subscription
                    newExpiresAt = new Date(now.getTime() + planDurationMs);

                    subscriptionData = {
                        user_id: userId,
                        plan_id: plan.id,
                        title: plan.title,
                        role_id: plan.role_id,
                        status: "active",
                        created_at: now,
                        started_at: now,
                        expires_at: newExpiresAt,
                        updated_at: now,
                        duration_days: plan.days,
                        original_price_vv: parseFloat(plan.price_vv),
                        paid_price_vv: finalPrice,
                        total_paid_vv: finalPrice,
                        discount_applied: plan.discount || null,
                        renewal_count: 0,
                        warning_sent: false,
                    };

                    const subscriptionResult = await db
                        .collection("subscriptions")
                        .insertOne(subscriptionData, { session });
                    subscriptionData._id = subscriptionResult.insertedId;
                }

                // Deduct balance from user (maintain decimal precision)
                const newBalance = userBalance - finalPrice;
                await db.collection("users").updateOne(
                    { _id: userId },
                    {
                        $set: { 
                            vv_balance: newBalance,
                            updated_at: now 
                        },
                    },
                    { session }
                );

                // Create transaction record with decimal support
                const transactionData = {
                    user_id: userId,
                    subscription_id: subscriptionData._id,
                    plan_id: plan.id,
                    plan_title: plan.title,
                    amount_vv: parseFloat(plan.price_vv),
                    final_price_vv: finalPrice,
                    discount_applied: plan.discount || null,
                    discount_amount: parseFloat(plan.price_vv) - finalPrice,
                    transaction_type: isRenewal ? "renewal" : "purchase",
                    created_at: now,
                    idempotency_key: idempotencyKey,
                    status: "completed",
                    type: "subscription_purchase",
                    user_balance_before: userBalance,
                    user_balance_after: newBalance,
                    duration_days: plan.days,
                };

                const transactionResult = await db
                    .collection("transactions")
                    .insertOne(transactionData, { session });

                result = {
                    success: true,
                    finalPrice,
                    subscription: subscriptionData,
                    transaction: {
                        ...transactionData,
                        _id: transactionResult.insertedId,
                    },
                    isRenewal,
                    user: user,
                };
            });

            // Immediately assign Discord role after successful purchase
            try {
                await this.assignDiscordRole(userId, plan.role_id);
                console.log(
                    `[INFO] Discord role ${plan.role_id} assigned to user ${userId}`
                );
            } catch (roleError) {
                console.error(
                    `[ERROR] Failed to assign Discord role after purchase:`,
                    roleError
                );
            }

            // Post-transaction operations (async)
            setImmediate(async () => {
                try {
                    // Send purchase notification to Discord channel
                    await this.sendPurchaseChannelMessage(
                        result.user,
                        plan,
                        result.subscription.created_at ||
                        result.subscription.last_renewed_at,
                        result.subscription.expires_at,
                        result.isRenewal
                    );

                    // Send transaction record to transactions channel
                    await this.sendTransactionChannelMessage(
                        result.transaction,
                        result.user,
                        plan
                    );

                    console.log(
                        `[INFO] User ${result.user.username} (${userId}) ${result.isRenewal ? "renewed" : "purchased"
                        } subscription ${plan.id} for ${this.formatVV(result.finalPrice)} VV`
                    );

                    // Update Discord bot status
                    if (discordStatusManager && !result.isRenewal) {
                        await discordStatusManager.forceStatusUpdate();
                        console.log(
                            `[INFO] Discord bot status updated after new subscription`
                        );
                    }
                } catch (error) {
                    console.error(
                        `[ERROR] Post-purchase operations failed for user ${userId}:`,
                        error
                    );
                }
            });

            return result;
        } catch (error) {
            console.error(
                `[ERROR] Purchase transaction failed for user ${userId}:`,
                error
            );
            throw error;
        } finally {
            await session.endSession();
        }
    }

    static async getUserActiveSubscription(userId) {
        const db = getDB();
        const now = new Date();

        try {
            const subscription = await db.collection("subscriptions").findOne({
                user_id: userId,
                status: "active",
                expires_at: { $gt: now },
            });

            if (!subscription) return null;

            const timeLeft = subscription.expires_at - now;
            const daysLeft = Math.floor(timeLeft / (24 * 60 * 60 * 1000));
            const hoursLeft = Math.floor(
                (timeLeft % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000)
            );
            const monthsLeft = Math.floor(daysLeft / 30);

            const totalDuration = subscription.expires_at - subscription.started_at;
            const elapsed = now - subscription.started_at;
            const progressPercent = Math.min(
                100,
                Math.max(0, (elapsed / totalDuration) * 100)
            );

            return {
                ...subscription,
                is_active: true,
                purchased_at_ist: this.formatIST(subscription.created_at),
                expires_at_ist: this.formatIST(subscription.expires_at),
                duration_text: this.formatDuration(subscription.duration_days),
                time_left: {
                    months: monthsLeft,
                    days: daysLeft % 30,
                    hours: hoursLeft,
                    total_days: daysLeft,
                },
                progress_percent: Math.round(progressPercent),
                renewal_info: {
                    count: subscription.renewal_count || 0,
                    last_renewed: subscription.last_renewed_at
                        ? this.formatIST(subscription.last_renewed_at)
                        : null,
                    total_spent: parseFloat(subscription.total_paid_vv || subscription.paid_price_vv),
                    formatted_total_spent: this.formatVV(subscription.total_paid_vv || subscription.paid_price_vv),
                },
            };
        } catch (error) {
            console.error(
                `[ERROR] Failed to get active subscription for user ${userId}:`,
                error
            );
            return null;
        }
    }

    // Method to handle subscription expiry (called by ExpiryManager)
    static async handleSubscriptionExpiry(subscriptionId) {
        try {
            const db = getDB();
            const now = new Date();

            // Update subscription status
            await db.collection("subscriptions").updateOne(
                { _id: subscriptionId },
                {
                    $set: {
                        status: "expired",
                        expired_at: now,
                        updated_at: now,
                    },
                }
            );

            // Update Discord bot status to reflect reduced subscription count
            if (discordStatusManager) {
                await discordStatusManager.forceStatusUpdate();
                console.log(
                    `[INFO] Discord bot status updated after subscription expiry`
                );
            }
        } catch (error) {
            console.error(
                `[ERROR] Failed to handle subscription expiry for ${subscriptionId}:`,
                error
            );
            throw error;
        }
    }

    static async assignDiscordRole(userId, roleId) {
        if (!process.env.DISCORD_GUILD_ID || !process.env.DISCORD_BOT_TOKEN) {
            throw new Error(
                "Discord configuration missing - DISCORD_GUILD_ID or DISCORD_BOT_TOKEN not set"
            );
        }

        try {
            const response = await axios.put(
                `https://discord.com/api/guilds/${process.env.DISCORD_GUILD_ID}/members/${userId}/roles/${roleId}`,
                {},
                {
                    headers: {
                        Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
                        "Content-Type": "application/json",
                    },
                    timeout: 10000,
                }
            );

            console.log(
                `[INFO] Role ${roleId} successfully assigned to user ${userId}`
            );
            return response.data;
        } catch (error) {
            if (error.response?.status === 404) {
                throw new Error(
                    "User not found in Discord server or role does not exist"
                );
            } else if (error.response?.status === 403) {
                throw new Error("Bot lacks permission to assign roles");
            } else if (error.response?.status === 400) {
                throw new Error("Invalid role or user ID");
            }

            console.error(`[ERROR] Role assignment failed for user ${userId}:`, {
                status: error.response?.status,
                data: error.response?.data,
                message: error.message,
            });
            throw error;
        }
    }

    static async removeDiscordRole(userId, roleId) {
        if (!process.env.DISCORD_GUILD_ID || !process.env.DISCORD_BOT_TOKEN) {
            console.warn(
                "[WARN] Discord role removal skipped - missing configuration"
            );
            return;
        }

        try {
            await axios.delete(
                `https://discord.com/api/guilds/${process.env.DISCORD_GUILD_ID}/members/${userId}/roles/${roleId}`,
                {
                    headers: {
                        Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
                        "Content-Type": "application/json",
                    },
                    timeout: 10000,
                }
            );
            console.log(`[INFO] Role ${roleId} removed from user ${userId}`);
        } catch (error) {
            console.error(
                `[ERROR] Role removal failed for user ${userId}:`,
                error.response?.data || error.message
            );
        }
    }

    static formatIST(date) {
        return (
            new Intl.DateTimeFormat("en-IN", {
                weekday: "long",
                day: "numeric",
                month: "long",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                timeZone: "Asia/Kolkata",
            }).format(date) + " IST"
        );
    }

    // Convert date to Discord timestamp format
    static formatDiscordTimestamp(date, style = "F") {
        const timestamp = Math.floor(date.getTime() / 1000);
        return `<t:${timestamp}:${style}>`;
    }

    static async getGuildInfo() {
        if (!process.env.DISCORD_GUILD_ID || !process.env.DISCORD_BOT_TOKEN) {
            return null;
        }

        try {
            const response = await axios.get(
                `https://discord.com/api/guilds/${process.env.DISCORD_GUILD_ID}`,
                {
                    headers: {
                        Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
                        "Content-Type": "application/json",
                    },
                    timeout: 5000,
                }
            );

            return {
                name: response.data.name,
                icon: response.data.icon
                    ? `https://cdn.discordapp.com/icons/${process.env.DISCORD_GUILD_ID}/${response.data.icon}.png`
                    : null,
            };
        } catch (error) {
            console.error("[ERROR] Failed to get guild info:", error.message);
            return null;
        }
    }

    // Helper method to get user's Discord profile image
    static async getUserProfileImage(userId) {
        if (!process.env.DISCORD_BOT_TOKEN) {
            return null;
        }

        try {
            const response = await axios.get(
                `https://discord.com/api/users/${userId}`,
                {
                    headers: {
                        Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
                        "Content-Type": "application/json",
                    },
                    timeout: 5000,
                }
            );

            const user = response.data;
            if (user.avatar) {
                const format = user.avatar.startsWith('a_') ? 'gif' : 'png';
                return `https://cdn.discordapp.com/avatars/${userId}/${user.avatar}.${format}?size=256`;
            } else {
                // Default Discord avatar based on discriminator
                const defaultAvatarIndex = user.discriminator === '0' ? 
                    (parseInt(userId) >> 22) % 6 : // New username system
                    parseInt(user.discriminator) % 5; // Legacy discriminator system
                return `https://cdn.discordapp.com/embed/avatars/${defaultAvatarIndex}.png`;
            }
        } catch (error) {
            console.error(`[ERROR] Failed to get user profile image for ${userId}:`, error.message);
            return null;
        }
    }

    static async sendChannelMessage(channelId, content) {
        if (!process.env.DISCORD_BOT_TOKEN) {
            console.warn(
                "[WARN] Discord message sending skipped - missing bot token"
            );
            return;
        }

        try {
            const response = await axios.post(
                `https://discord.com/api/channels/${channelId}/messages`,
                content,
                {
                    headers: {
                        Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
                        "Content-Type": "application/json",
                    },
                    timeout: 10000,
                }
            );

            console.log(`[INFO] Message sent to channel ${channelId}`);
            return response.data;
        } catch (error) {
            console.error(`[ERROR] Failed to send message to channel ${channelId}:`, {
                status: error.response?.status,
                data: error.response?.data,
                message: error.message,
            });
            throw error;
        }
    }

    // Purchase notification with enhanced decimal formatting
    static async sendPurchaseChannelMessage(user, plan, purchasedAt, expiresAt, isRenewal) {
        const channelId = process.env.DISCORD_PURCHASE_CHANNEL_ID;
        if (!channelId) {
            console.warn('[WARN] Purchase notification skipped - DISCORD_PURCHASE_CHANNEL_ID not set');
            return;
        }

        try {
            const guildInfo = await this.getGuildInfo();
            const userProfileImage = await this.getUserProfileImage(user._id);
            const durationText = this.formatDuration(plan.days);
            const priceInfo = this.calculateFinalPrice(plan, true);

            const embed = {
                color: 0x00ff7f, // Green color
                author: {
                    name: "🎉 New Subscription Added",
                    icon_url: "https://cdn.discordapp.com/attachments/1404364069351460967/1413848167824232518/vireeeee.png"
                },
                description: `<@${user._id}> has received a subscription!`,
                thumbnail: {
                    url: userProfileImage || "https://cdn.discordapp.com/embed/avatars/0.png"
                },
                fields: [
                    {
                        name: "👤 User",
                        value: `<@${user._id}>\n${user.discord?.username || user.username}`,
                        inline: true
                    },
                    {
                        name: "📅 Duration",
                        value: durationText,
                        inline: true
                    },
                    {
                        name: "⏰ Expires",
                        value: this.formatDiscordTimestamp(expiresAt, 'F'),
                        inline: true
                    },
                    {
                        name: "💎 Amount",
                        value: `${priceInfo.formattedFinal} VV${priceInfo.discountAmount > 0 ? ` (${priceInfo.formattedDiscount} VV saved!)` : ''}`,
                        inline: true
                    },
                    {
                        name: "🏷️ Role",
                        value: `<@&${plan.role_id}>`,
                        inline: true
                    },
                    {
                        name: "📋 Status",
                        value: isRenewal ? "🔄 Renewed" : "🆕 New subscription",
                        inline: true
                    }
                ],
                footer: {
                    text: `Added by ${user.discord?.username || user.username}`,
                    icon_url: "https://cdn.discordapp.com/attachments/1404364069351460967/1413848167824232518/vireeeee.png"
                },
                timestamp: new Date().toISOString()
            };

            // Send message with user mention and embed
            const messageContent = {
                content: `<@${user._id}>`, // Tag the user in the message
                embeds: [embed]
            };

            await this.sendChannelMessage(channelId, messageContent);
        } catch (error) {
            console.error('[ERROR] Purchase channel message failed:', error);
        }
    }

    // Transaction channel notification with enhanced decimal formatting
    static async sendTransactionChannelMessage(transaction, user, plan) {
        const channelId = process.env.DISCORD_TRANSACTION_CHANNEL_ID;
        if (!channelId) {
            console.warn(
                "[WARN] Transaction notification skipped - DISCORD_TRANSACTION_CHANNEL_ID not set"
            );
            return;
        }

        try {
            const guildInfo = await this.getGuildInfo();
            const userProfileImage = await this.getUserProfileImage(user._id);

            const isRenewal = transaction.transaction_type === "renewal";
            const discountText = transaction.discount_amount > 0
                ? `💰 Saved ${this.formatVV(transaction.discount_amount)} VV`
                : "💸 No discount";

            const embed = {
                color: isRenewal ? 0xffa500 : 0x28a745, // Orange for renewal, green for new
                author: {
                    name: isRenewal ? "🔄 Subscription Renewed" : "💰 New Transaction",
                    icon_url: "https://cdn.discordapp.com/attachments/1404364069351460967/1413848167824232518/vireeeee.png",
                },
                description: `Transaction completed for <@${user._id}>`,
                thumbnail: {
                    url: userProfileImage || "https://cdn.discordapp.com/embed/avatars/0.png"
                },
                fields: [
                    {
                        name: "👤 Customer",
                        value: `<@${user._id}>\n${user.discord?.username || user.username}`,
                        inline: true,
                    },
                    {
                        name: "📦 Plan",
                        value: `${plan.title}\n${this.formatDuration(transaction.duration_days)}`,
                        inline: true,
                    },
                    {
                        name: "💎 Amount",
                        value: `${this.formatVV(transaction.final_price_vv)} VV`,
                        inline: true,
                    },
                    {
                        name: "🏪 Type",
                        value: isRenewal ? "Renewal" : "New Purchase",
                        inline: true,
                    },
                    {
                        name: "💰 Savings",
                        value: discountText,
                        inline: true,
                    },
                    {
                        name: "⚖️ Balance",
                        value: `${this.formatVV(transaction.user_balance_before)} → ${this.formatVV(transaction.user_balance_after)} VV`,
                        inline: true,
                    },
                ],
                footer: {
                    text: `Transaction ID: ${transaction._id.toString().substr(-8)} • ${guildInfo?.name || "Virelia"}`,
                    icon_url: guildInfo?.icon || undefined,
                },
                timestamp: new Date().toISOString()
            };

            await this.sendChannelMessage(channelId, { embeds: [embed] });

            // Clean up - remove transaction from DB after sending to channel (as requested)
            setTimeout(async () => {
                try {
                    const db = getDB();
                    await db
                        .collection("transactions")
                        .deleteOne({ _id: transaction._id });
                    console.log(
                        `[INFO] Transaction ${transaction._id} cleaned up from database`
                    );
                } catch (error) {
                    console.error(
                        `[ERROR] Failed to cleanup transaction ${transaction._id}:`,
                        error
                    );
                }
            }, 5000); // 5 second delay to ensure message is sent
        } catch (error) {
            console.error("[ERROR] Transaction channel message failed:", error);
        }
    }

    static async sendExpiredChannelMessage(subscription) {
        const channelId = process.env.DISCORD_EXPIRY_CHANNEL_ID;
        if (!channelId) {
            console.warn(
                "[WARN] Expired notification skipped - DISCORD_EXPIRY_CHANNEL_ID not set"
            );
            return;
        }

        const db = getDB();
        const user = await db
            .collection("users")
            .findOne({ _id: subscription.user_id });
        if (!user) return;

        try {
            const guildInfo = await this.getGuildInfo();
            const userProfileImage = await this.getUserProfileImage(subscription.user_id);

            const embed = {
                title: "❌ Subscription Expired",
                description: `<@${subscription.user_id}>\nYour subscription has ended.`,
                color: 0xff0000,
                thumbnail: {
                    url: userProfileImage || "https://cdn.discordapp.com/embed/avatars/0.png"
                },
                fields: [
                    {
                        name: "👤 User",
                        value: `<@${subscription.user_id}>\n${user.discord?.username || user.username}`,
                        inline: true,
                    },
                    {
                        name: "🕐 Expired",
                        value: this.formatDiscordTimestamp(subscription.expires_at, "R"),
                        inline: false,
                    },
                    {
                        name: "📅 Exact Time",
                        value: this.formatDiscordTimestamp(subscription.expires_at, "F"),
                        inline: false,
                    },
                    {
                        name: "🏷️ Role Removed",
                        value: `<@&${subscription.role_id}>`,
                        inline: true,
                    },
                    {
                        name: "💎 Total Spent",
                        value: `${this.formatVV(subscription.total_paid_vv || subscription.paid_price_vv)} VV`,
                        inline: true,
                    },
                ],
                footer: {
                    text: guildInfo
                        ? `${guildInfo.name} • Subscription System`
                        : "Virelia • by roster",
                    icon_url: guildInfo?.icon || undefined,
                },
                timestamp: new Date().toISOString()
            };

            await this.sendChannelMessage(channelId, {content: `<@${user._id}>`, embeds: [embed] });

            // Update Discord bot status after expiry notification
            if (discordStatusManager) {
                setTimeout(() => {
                    discordStatusManager.forceStatusUpdate();
                }, 2000);
            }
        } catch (error) {
            console.error("[ERROR] Expired channel message failed:", error);
        }
    }

    // Expiry warning notification with enhanced decimal formatting
    static async sendExpiryWarningChannelMessage(subscription) {
        const channelId = process.env.DISCORD_WARNING_CHANNEL_ID || process.env.DISCORD_EXPIRY_CHANNEL_ID;
        if (!channelId) {
            console.warn(
                "[WARN] Expiry warning notification skipped - DISCORD_WARNING_CHANNEL_ID or DISCORD_EXPIRY_CHANNEL_ID not set"
            );
            return;
        }

        const db = getDB();
        const user = await db
            .collection("users")
            .findOne({ _id: subscription.user_id });
        if (!user) return;

        try {
            const guildInfo = await this.getGuildInfo();
            const userProfileImage = await this.getUserProfileImage(subscription.user_id);

            // Calculate time remaining
            const now = new Date();
            const timeLeft = subscription.expires_at - now;
            const daysLeft = Math.floor(timeLeft / (24 * 60 * 60 * 1000));
            const hoursLeft = Math.floor((timeLeft % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));

            let warningMessage = "";
            if (daysLeft > 0) {
                warningMessage = `Your subscription expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}${hoursLeft > 0 ? ` and ${hoursLeft} hour${hoursLeft === 1 ? '' : 's'}` : ''}!`;
            } else if (hoursLeft > 0) {
                warningMessage = `Your subscription expires in ${hoursLeft} hour${hoursLeft === 1 ? '' : 's'}!`;
            } else {
                warningMessage = "Your subscription expires very soon!";
            }

            const embed = {
                title: "⚠️ Subscription Expiring Soon",
                description: `<@${subscription.user_id}>\n${warningMessage}`,
                color: 0xffa500, // Orange color for warning
                thumbnail: {
                    url: userProfileImage || "https://cdn.discordapp.com/embed/avatars/0.png"
                },
                fields: [
                    {
                        name: "👤 User",
                        value: `<@${subscription.user_id}>\n${user.discord?.username || user.username}`,
                        inline: true,
                    },
                    {
                        name: "💎 Plan",
                        value: subscription.title || "Premium",
                        inline: true,
                    },
                    {
                        name: "⏰ Expires",
                        value: this.formatDiscordTimestamp(subscription.expires_at, 'F'),
                        inline: true,
                    },
                    {
                        name: "⏳ Time Remaining",
                        value: this.formatDiscordTimestamp(subscription.expires_at, 'R'),
                        inline: true,
                    },
                    {
                        name: "🏷️ Role",
                        value: `<@&${subscription.role_id}>`,
                        inline: true,
                    },
                    {
                        name: "💰 Total Spent",
                        value: `${this.formatVV(subscription.total_paid_vv || subscription.paid_price_vv)} VV`,
                        inline: true,
                    },
                    {
                        name: "💡 Action",
                        value: "Renew your subscription to continue enjoying premium features!",
                        inline: false,
                    }
                ],
                footer: {
                    text: guildInfo
                        ? `${guildInfo.name} • Subscription System`
                        : "Virelia • by roster",
                    icon_url: guildInfo?.icon || undefined,
                },
                timestamp: new Date().toISOString()
            };

            await this.sendChannelMessage(channelId, {content: `<@${user._id}>`, embeds: [embed] });

            console.log(`[INFO] Expiry warning sent for subscription ${subscription._id}`);
        } catch (error) {
            console.error("[ERROR] Expiry warning channel message failed:", error);
        }
    }

    // Legacy webhook methods (kept for backwards compatibility)
    static async sendExpiryWarningWebhook(subscription) {
        return this.sendExpiryWarningChannelMessage(subscription);
    }

    static async sendExpiredWebhook(subscription) {
        return this.sendExpiredChannelMessage(subscription);
    }
}

module.exports = SubscriptionService;