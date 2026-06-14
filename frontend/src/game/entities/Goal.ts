import Phaser from 'phaser';
import { Ball } from './Ball';

export class Goal extends Phaser.GameObjects.Rectangle {
  readonly side: 'left' | 'right';

  constructor(scene: Phaser.Scene, side: 'left' | 'right', centerY: number) {
    const width = 14;
    const height = 150;
    const x = side === 'left' ? 0 : 1200;
    super(scene, x, centerY, width, height, 0xffffff, 0.25);
    this.side = side;
    this.setStrokeStyle(2, 0xffffff, 1);
    this.setDepth(2);
    scene.add.existing(this);
  }

  containsBall(ball: Ball): boolean {
    const halfH = this.height / 2;
    const top = this.y - halfH;
    const bottom = this.y + halfH;
    if (ball.y < top || ball.y > bottom) return false;
    if (this.side === 'left') return ball.x < this.x + this.width / 2 + 5;
    return ball.x > this.x - this.width / 2 - 5;
  }
}
