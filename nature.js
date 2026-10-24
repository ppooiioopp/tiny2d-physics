/*!
 * TinyNature v1.0.0 — 自然物体的几何形状生成
 * ------------------------------------------------------------
 * 为 Tiny2D 物理引擎生成“自然界里真实存在”的凸形状：
 *   - 石头：随机凹凸轮廓 + 凸包保证合法性
 *   - 木头：胶囊形原木 / 树枝
 *   - 树叶：两端尖、中间宽的叶片
 *
 * 浏览器：先加载 physics.js，再加载 nature.js → 全局 TinyNature
 * Node.js：const Nature = require('./nature.js')
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const Tiny2D = require('./physics.js');
    module.exports = factory(Tiny2D);
  } else {
    root.TinyNature = factory(root.Tiny2D);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Tiny2D) {
  'use strict';

  const { Vec2, Shapes } = Tiny2D;

  /**
   * Andrew monotone chain 凸包。
   * 输入任意 Vec2 数组，返回逆时针排列的凸包顶点。
   */
  function convexHull(points) {
    if (points.length <= 2) return points.slice();

    const pts = points
      .slice()
      .sort(function (a, b) {
        return a.x === b.x ? a.y - b.y : a.x - b.x;
      });

    function cross(o, a, b) {
      return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    }

    const lower = [];
    for (const p of pts) {
      while (
        lower.length >= 2 &&
        cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
      ) {
        lower.pop();
      }
      lower.push(p);
    }

    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (
        upper.length >= 2 &&
        cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
      ) {
        upper.pop();
      }
      upper.push(p);
    }

    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  // 小随机数（不引入依赖，方便测试复现时替换 Math.random）
  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  /**
   * 生成一块石头。
   * @param {number} radius 名义半径（米）
   * @param {number} flatten 竖向压扁系数，1 为接近圆形
   * @param {number} roughness 轮廓粗糙度 0~1，越小越规整（适合垒石堆）
   * @returns {{shape: Tiny2D.Polygon, specks: Array, radius: number}}
   */
  function makeRockShape(radius, flatten, roughness) {
    if (!(radius > 0)) throw new Error('石头半径必须大于 0');
    const f = flatten == null ? 1 : flatten;
    const rough = roughness == null ? 0.3 : Math.max(0, Math.min(1, roughness));
    const count = 8 + Math.floor(Math.random() * 4);
    const points = [];

    for (let i = 0; i < count; i++) {
      const angle =
        (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.12 * rough;
      const r = radius * (1 - rough * 0.5 + Math.random() * rough);
      points.push(new Vec2(Math.cos(angle) * r, Math.sin(angle) * r * f));
    }

    let hull = convexHull(points);
    // 极端情况下凸包退化，退回到矩形保证可用
    const shape =
      hull.length >= 3 ? Shapes.polygon(hull) : Shapes.box(radius * 1.7, radius * 1.7 * f);

    // 石头表面的小斑点（仅用于渲染，局部坐标）
    const specks = [];
    const speckCount = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < speckCount; i++) {
      specks.push({
        x: (Math.random() - 0.5) * radius * 0.95,
        y: (Math.random() - 0.5) * radius * 0.5 * f,
        r: radius * (0.04 + Math.random() * 0.06),
        a: 0.08 + Math.random() * 0.12,
      });
    }

    return { shape, specks, radius };
  }

  /**
   * 生成一块“扁石”——上下表面平整，适合垒石堆。
   * 侧面保留少量不规则，看起来仍然像天然石头。
   * @param {number} radius 名义半径（米），宽度约为两倍半径
   * @param {number} thickness 厚度（米）
   * @param {number} roughness 侧面凹凸程度 0~1
   */
  function makeFlatStoneShape(radius, thickness, roughness) {
    if (!(radius > 0) || !(thickness > 0)) {
      throw new Error('扁石尺寸必须大于 0');
    }
    const w = radius * 2;
    const h = thickness;
    const rough = roughness == null ? 0.12 : roughness;
    const j = function () {
      return (Math.random() - 0.5) * rough;
    };

    const points = [
      new Vec2(-w * 0.34, h / 2), // 底边左
      new Vec2(w * 0.34, h / 2), // 底边右
      new Vec2(w * (0.5 + j() * 0.1), h * (0.2 + j() * 0.08)),
      new Vec2(w * (0.48 + j() * 0.1), -h * (0.2 + j() * 0.08)),
      new Vec2(w * 0.3, -h / 2), // 顶边右
      new Vec2(-w * 0.3, -h / 2), // 顶边左
      new Vec2(-w * (0.48 + j() * 0.1), -h * (0.2 + j() * 0.08)),
      new Vec2(-w * (0.5 + j() * 0.1), h * (0.2 + j() * 0.08)),
    ];

    const hull = convexHull(points);
    const shape = hull.length >= 3 ? Shapes.polygon(hull) : Shapes.box(w, h);

    const specks = [];
    for (let i = 0; i < 3; i++) {
      specks.push({
        x: (Math.random() - 0.5) * radius * 0.9,
        y: (Math.random() - 0.5) * thickness * 0.5,
        r: radius * (0.03 + Math.random() * 0.05),
        a: 0.08 + Math.random() * 0.12,
      });
    }

    return { shape, specks, radius };
  }

  /**
   * 生成一段原木 / 树枝（胶囊形，两端为半圆）。
   * @param {number} length 总长度（米）
   * @param {number} thickness 总粗细（米）
   */
  function makeLogShape(length, thickness) {
    if (!(length > 0) || !(thickness > 0)) {
      throw new Error('木头长度与粗细必须大于 0');
    }
    const radius = thickness / 2;
    const half = length / 2 - radius;
    if (half <= 0) {
      // 长度比粗细还小：退化为圆
      return Shapes.circle(radius);
    }

    const points = [];
    const segments = 5;

    // 右端半圆（-90° → +90°）
    for (let i = 0; i <= segments; i++) {
      const angle = -Math.PI / 2 + (Math.PI * i) / segments;
      points.push(
        new Vec2(half + Math.cos(angle) * radius, Math.sin(angle) * radius)
      );
    }
    // 左端半圆（90° → 270°）
    for (let i = 0; i <= segments; i++) {
      const angle = Math.PI / 2 + (Math.PI * i) / segments;
      points.push(
        new Vec2(-half + Math.cos(angle) * radius, Math.sin(angle) * radius)
      );
    }

    return Shapes.polygon(points);
  }

  /**
   * 生成一片叶子：两端尖、中间宽，整体为凸多边形。
   * @param {number} length 叶长（米）
   * @param {number} width 叶宽（米）
   */
  function makeLeafShape(length, width) {
    if (!(length > 0) || !(width > 0)) {
      throw new Error('叶子长度与宽度必须大于 0');
    }
    const half = length / 2;
    const hw = width / 2;

    return Shapes.polygon([
      new Vec2(-half, 0),
      new Vec2(-half * 0.55, -hw * 0.7),
      new Vec2(-half * 0.05, -hw),
      new Vec2(half * 0.45, -hw * 0.65),
      new Vec2(half, 0),
      new Vec2(half * 0.45, hw * 0.65),
      new Vec2(-half * 0.05, hw),
      new Vec2(-half * 0.55, hw * 0.7),
    ]);
  }

  return {
    version: '1.0.0',
    convexHull,
    makeRockShape,
    makeFlatStoneShape,
    makeLogShape,
    makeLeafShape,
  };
});
