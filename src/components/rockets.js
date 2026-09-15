// Rocket sprites (asset/): nose points UP at rest, so rotation maps the last
// travel direction to the nose. Colours without a sprite (e.g. silver)
// fall back to the classic dot — see Board.jsx.
import redRocket from '../../asset/red_rocket.png';
import blueRocket from '../../asset/blue_rocket.png';
import greenRocket from '../../asset/green_rocket.png';
import yellowRocket from '../../asset/yellow_rocket.png';
import silverRocket from '../../asset/silver_rocket.png';

export const ROCKET_IMG = {
  red: redRocket,
  blue: blueRocket,
  green: greenRocket,
  yellow: yellowRocket,
  silver: silverRocket,
};

/** CSS/SVG rotation (deg, clockwise) so the nose faces the travel direction. */
export function dirAngle(dir) {
  switch (dir) {
    case 'right':
      return 90;
    case 'down':
      return 180;
    case 'left':
      return 270;
    default:
      return 0; // 'up' or unknown faces up like the raw sprite
  }
}
