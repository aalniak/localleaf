/** Send data wrapped in the standard { success, data, error } envelope. */
export const ok = (res, data, status = 200) => res.status(status).json({ success: true, data, error: null });
