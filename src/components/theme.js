// Space theme art (asset/): laser wall segments, the center-vault asteroid,
// and the board backdrop. (Source file is spelled "asteriod.png".)
import laserWall from '../../asset/laser_wall.png';
import spaceBg from '../../asset/space.avif';
import loadingVideo from '../../asset/loading.mp4';
import blockImg from '../../asset/green_block_round.png';
import iceImg from '../../asset/ice_tile.png';
import warpImg from '../../asset/warp_gate_round.png';
import whiteImg from '../../asset/white_tile_round.png';
import yellowImg from '../../asset/yellow_tile_round.png';

export { laserWall, spaceBg, loadingVideo, blockImg };
export const TILE_IMG = { ice: iceImg, warpA: warpImg, warpB: warpImg, white: whiteImg, yellow: yellowImg };

// Laser sprite is 360×66 → rendered longer than one edge (48u) so segments
// join at corners, height scaled to match (no distortion).
export const LASER_W = 48;
export const LASER_H = (LASER_W * 66) / 360;
