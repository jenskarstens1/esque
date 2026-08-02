/**
 * Compatibility surface for render code.
 *
 * Colour science belongs to the decoded working-image contract, not to WebGL.
 * New pipeline code imports from `core/color`; existing render/UI imports keep
 * this re-export so the move does not create two competing implementations.
 */
export * from '../core/color'
