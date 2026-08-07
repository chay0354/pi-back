/** Cumulative review counts required for star levels 1–5 (broker / professional). */
const BROKER_PRO_STAR_THRESHOLDS = [5, 15, 35, 75, 155];
const BROKER_PRO_LOW_RATING_WINDOW = 50;
const BROKER_PRO_LOW_RATING_DROP_AT = 10;
const BROKER_PRO_STARTING_STARS = 1;

const reviewTimestamp = review => {
  const t = new Date(review?.created_at || 0).getTime();
  return Number.isFinite(t) ? t : 0;
};

const brokerProfessionalStarsFromCount = totalCount => {
  const total = Math.max(0, Number(totalCount) || 0);
  let stars = 0;
  for (let i = BROKER_PRO_STAR_THRESHOLDS.length - 1; i >= 0; i--) {
    if (total >= BROKER_PRO_STAR_THRESHOLDS[i]) {
      stars = i + 1;
      break;
    }
  }
  return stars;
};

/** @returns {number} 1–5 */
function computeBrokerProfessionalStarRating(reviews) {
  if (!Array.isArray(reviews) || reviews.length === 0) {
    return BROKER_PRO_STARTING_STARS;
  }

  let stars = brokerProfessionalStarsFromCount(reviews.length);
  if (stars <= 0) {
    return BROKER_PRO_STARTING_STARS;
  }

  const sorted = [...reviews].sort(
    (a, b) => reviewTimestamp(b) - reviewTimestamp(a),
  );
  const lastWindow = sorted.slice(0, BROKER_PRO_LOW_RATING_WINDOW);
  const lowCount = lastWindow.filter(r => {
    const n = Number(r?.rating);
    return n === 1 || n === 2;
  }).length;

  if (lowCount >= BROKER_PRO_LOW_RATING_DROP_AT) {
    stars = Math.max(1, stars - 1);
  }

  return Math.min(5, Math.max(1, stars));
}

module.exports = {
  computeBrokerProfessionalStarRating,
};
