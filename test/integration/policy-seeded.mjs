export async function policySeeded(page) {
  await page
    .within(60000, async () => {
      const client = await globalThis.sliccKernelClient();
      const observed = [];
      try {
        for (const path of [
          '/etc/fnox',
          '/etc/slicc',
          '/etc/fnox/config.toml',
          '/etc/slicc/secrets-policy.toml',
        ]) {
          const stat = await client.fs.lstat(path);
          observed.push({
            path,
            uid: stat.uid,
            gid: stat.gid,
            mode: stat.mode & 0o7777,
            file: stat.isFile,
            directory: stat.isDirectory,
            link: stat.isSymbolicLink,
          });
        }
        globalThis.sliccPolicySeedState = observed;
        return observed.every(
          (stat, index) =>
            stat.uid === 0 &&
            stat.gid === 0 &&
            stat.link === false &&
            (index < 2
              ? stat.directory === true && stat.mode === 0o755
              : stat.file === true && stat.mode === 0o644)
        );
      } catch (error) {
        globalThis.sliccPolicySeedState = { observed, error: String(error.message) };
        return false;
      } finally {
        await client.close();
      }
    })
    .catch(async (error) => {
      const state = await page.evaluate(() => globalThis.sliccPolicySeedState);
      throw new Error(
        `the trusted policy seed did not finish: ${JSON.stringify(state)}; ${error.message}`
      );
    });
}
