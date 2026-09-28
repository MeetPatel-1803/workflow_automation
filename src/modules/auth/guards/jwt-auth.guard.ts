// The guard lives in common/ because it is applied app-wide (APP_GUARD);
// re-exported here so the auth module's public surface is discoverable.
export { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
