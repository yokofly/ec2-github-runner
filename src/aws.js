const AWS = require('aws-sdk');
const core = require('@actions/core');
const config = require('./config');

// User data scripts are run as the root user
function buildUserDataScript(githubRegistrationToken, label) {
  if (config.input.runnerHomeDir) {
    // If runner home directory is specified, we expect the actions-runner software (and dependencies)
    // to be pre-installed in the AMI, so we simply cd into that directory and then start the runner
    return [
      '#!/bin/bash',
      `cd "${config.input.runnerHomeDir}"`,
      'export RUNNER_ALLOW_RUNASROOT=1',
      `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label}`,
      './run.sh',
    ];
  } else {
    return [
      '#!/bin/bash',
      'mkdir actions-runner && cd actions-runner',
      'case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=${ARCH}',
      'RUNNER_VERSION=$(curl -s "https://api.github.com/repos/actions/runner/releases/latest" | grep -o \'"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"\' | sed \'s/.*"tag_name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/\' | tr -d "v")',
      'curl -O -L https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz',
      'tar xzf ./actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz',
      'export RUNNER_ALLOW_RUNASROOT=1',
      `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label}`,
      './run.sh',
    ];
  }
}

async function startEc2Instance(label, githubRegistrationToken) {
  const ec2 = new AWS.EC2();

  const userData = buildUserDataScript(githubRegistrationToken, label);

  const params = {
    ImageId: config.input.ec2ImageId,
    InstanceType: config.input.ec2InstanceType,
    KeyName: config.input.keyName,
    MinCount: 1,
    MaxCount: 1,
    UserData: Buffer.from(userData.join('\n')).toString('base64'),
    SubnetId: config.input.subnetId,
    SecurityGroupIds: [config.input.securityGroupId],
    IamInstanceProfile: { Name: config.input.iamRoleName },
    TagSpecifications: config.tagSpecifications,
    BlockDeviceMappings: [
      {
        DeviceName: config.input.ec2DeviceName,
        Ebs: {
          VolumeSize: config.input.ec2VolumeSize,
        },
      },
    ],
  };

  try {
    const result = await ec2.runInstances(params).promise();
    const ec2InstanceId = result.Instances[0].InstanceId;
    core.info(`AWS EC2 instance ${ec2InstanceId} is started`);
    return ec2InstanceId;
  } catch (error) {
    core.error('AWS EC2 instance starting error');
    throw error;
  }
}

async function startEc2SpotInstance(label, githubRegistrationToken) {
  const ec2 = new AWS.EC2();

  const userData = buildUserDataScript(githubRegistrationToken, label);
  const launchSpec = {
    ImageId: config.input.ec2ImageId,
    InstanceType: config.input.ec2InstanceType,
    KeyName: config.input.keyName,
    UserData: Buffer.from(userData.join('\n')).toString('base64'),
    SubnetId: config.input.subnetId,
    SecurityGroupIds: [config.input.securityGroupId],
    IamInstanceProfile: { Name: config.input.iamRoleName },
    BlockDeviceMappings: [
      {
        DeviceName: config.input.ec2DeviceName,
        Ebs: {
          VolumeSize: config.input.ec2VolumeSize,
        },
      },
    ],
  };

  const spotRequestParams = {
    InstanceCount: 1,
    LaunchSpecification: launchSpec,
    Type: 'one-time',
  };

  try {
    const result = await ec2.requestSpotInstances(spotRequestParams).promise();
    const spotRequestId = result.SpotInstanceRequests[0].SpotInstanceRequestId;
    const data = await ec2.waitFor('spotInstanceRequestFulfilled', { SpotInstanceRequestIds: [spotRequestId] }).promise();
    const ec2InstanceId = data.SpotInstanceRequests[0].InstanceId;

    // add tags
    var tag_params = {
      Resources: [`${ec2InstanceId}`],
      Tags: config.tagSpecifications[0].Tags,
    };

    core.info(`${tag_params}`);
    await ec2.createTags(tag_params).promise();

    core.info(`AWS EC2 instance ${ec2InstanceId} is started`);
    return ec2InstanceId;
  } catch (error) {
    core.error('AWS EC2 instance starting error');
    throw error;
  }
}

async function terminateEc2Instance() {
  const ec2 = new AWS.EC2();

  const params = {
    InstanceIds: [config.input.ec2InstanceId],
  };

  try {
    await ec2.terminateInstances(params).promise();
    core.info(`AWS EC2 instance ${config.input.ec2InstanceId} is terminated`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${config.input.ec2InstanceId} termination error`);
    throw error;
  }
}

async function waitForInstanceRunning(ec2InstanceId) {
  const ec2 = new AWS.EC2();

  const params = {
    InstanceIds: [ec2InstanceId],
  };

  try {
    await ec2.waitFor('instanceRunning', params).promise();
    core.info(`AWS EC2 instance ${ec2InstanceId} is up and running`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${ec2InstanceId} initialization error`);
    throw error;
  }
}

module.exports = {
  startEc2Instance,
  startEc2SpotInstance,
  terminateEc2Instance,
  waitForInstanceRunning,
};
