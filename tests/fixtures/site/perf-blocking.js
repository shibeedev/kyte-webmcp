// Render-blocking script with some work and an unused function (for coverage).
window.usedFunction = function () {
  return 1 + 1;
};
window.unusedFunction = function () {
  const values = [];
  for (let i = 0; i < 10; i++) values.push(i * 2);
  return values.join(',');
};
window.usedFunction();
