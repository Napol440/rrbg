// Space theme art (asset/): laser wall segments, the center-vault asteroid,
// and the board backdrop. (Source file is spelled "asteriod.png".)
import laserWall from '../../asset/laser_wall.png';
import asteroidImg from '../../asset/asteriod.png';
import spaceBg from '../../asset/space.avif';

export { laserWall, asteroidImg, spaceBg };

// Laser sprite is 360×66 → rendered longer than one edge (48u) so segments
// join at corners, height scaled to match (no distortion).
export const LASER_W = 48;
export const LASER_H = (LASER_W * 66) / 360;
