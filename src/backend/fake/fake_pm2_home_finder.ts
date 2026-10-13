import { IContainer } from '../container';
import { define } from '../framework/dependency_injection';
import { IPm2HomeFinder } from '../lib/pm2_home_finder';

/** Stands in for `pm2HomeFinder` in fake mode, so nothing looks for PM2 on this computer. */
export function createPm2HomeFinder({ fakeWorld }: IContainer): IPm2HomeFinder {
  return new (class FakePm2HomeFinder {
    find = async () => fakeWorld.detectableHomes();
  })();
}

export default define({
  createPm2HomeFinder,
});
